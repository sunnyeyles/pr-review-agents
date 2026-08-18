/**
 * One review, end to end: load the PR, run the pipeline, render the
 * check run, publish it, and emit the spec §26 lifecycle events along
 * the way.
 *
 * This is the shared body of every delivery path. The worker Lambda
 * wraps it in SQS record parsing and partial-batch semantics; the
 * GitHub Action wraps it in Actions event parsing. Neither owns the
 * publish step, which matters: the deterministic side-effect boundary
 * (spec §17) is enforced here, once, rather than copied per wrapper.
 *
 * What stays outside: authentication (callers resolve their own
 * client — App installation or workflow token) and retry semantics
 * (SQS provides them for the worker, Actions for the Action).
 */
import type { ReviewContext } from "@pr-review/ai";
import type { GithubInstallationClient } from "@pr-review/github";
import { createConsoleLogger, type StructuredLogger } from "@pr-review/logging";

import { renderCheckRun, type RenderedCheckRun } from "./render-check-run.js";
import type { ReviewPipelineResult } from "./review-graph.js";

/** The pull request one review runs against. */
export interface ReviewTarget {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
}

/**
 * Delivers the rendered review. The default publishes an "AI PR
 * Review" check run; the Action injects a variant that falls back to
 * the workflow job summary when the workflow token lacks
 * `checks: write` (fork pull requests).
 */
export type PublishReview = (
  target: ReviewTarget,
  rendered: RenderedCheckRun,
) => Promise<void>;

export interface ReviewPullRequestDeps {
  /** Authenticated read-only GitHub client for this repository. */
  client: GithubInstallationClient;
  /**
   * Runs the full review pipeline (@pr-review/reviewer's LangGraph
   * StateGraph, spec §8/§16/§17/§20): the review agents fan out over
   * the loaded PR context, their raw candidates are refined by the AI
   * Synthesiser, and the deterministic validation chain produces the
   * final findings. Throws when every agent failed, which callers
   * surface as a failed review so their own retry semantics apply. A
   * synthesis failure never throws — it is reported on the result and
   * the raw candidates are published instead.
   */
  runReviewPipeline: (
    client: GithubInstallationClient,
    context: ReviewContext,
  ) => Promise<ReviewPipelineResult>;
  /** Defaults to publishing a check run through `client`. */
  publishReview?: PublishReview | undefined;
  /**
   * Structured lifecycle logger (spec §26): every event of one review
   * carries repository, PR number, and head SHA so an operator can
   * answer "what happened to the review for PR N?" from the logs
   * alone. Defaults to the console logger; tests inject a capturing
   * logger.
   */
  logger?: StructuredLogger | undefined;
}

/** The correlation fields every event of one review carries (spec §26). */
export function reviewCorrelation(
  target: ReviewTarget,
): Record<string, unknown> {
  return {
    repository: `${target.owner}/${target.repo}`,
    pullRequestNumber: target.pullRequestNumber,
    headSha: target.headSha,
  };
}

/** The default delivery: an "AI PR Review" check run on the head SHA. */
export function createCheckRunPublisher(
  client: GithubInstallationClient,
): PublishReview {
  return async (target, rendered) => {
    await client.createCheckRun({
      owner: target.owner,
      repo: target.repo,
      headSha: target.headSha,
      conclusion: rendered.conclusion,
      output: rendered.output,
    });
  };
}

/**
 * Logs the §16 synthesis outcome the pipeline already computed. The
 * two non-model paths carry their own event: a clean review (zero
 * candidates) logs synthesis.skipped; a synthesis failure logs
 * synthesis.failed and notes the fallback — the raw candidates still
 * flow through validateFindings inside the pipeline, so the review
 * never dies from a synthesis failure.
 */
function logSynthesisOutcome(
  logger: StructuredLogger,
  target: ReviewTarget,
  review: ReviewPipelineResult,
): void {
  const fields = reviewCorrelation(target);
  if (review.synthesisOutcome === "skipped") {
    logger.info("synthesis.skipped", { ...fields, reason: "no candidate findings" });
    return;
  }

  logger.info("synthesis.started", {
    ...fields,
    candidateCount: review.candidates.length,
  });
  if (review.synthesisOutcome === "completed") {
    logger.info("synthesis.completed", {
      ...fields,
      candidateCount: review.candidates.length,
      refinedCount: review.synthesisedCandidateCount,
      inputTokens: review.synthesisUsage.inputTokens,
      outputTokens: review.synthesisUsage.outputTokens,
      durationMs: review.synthesisDurationMs,
    });
    return;
  }

  logger.error("synthesis.failed", {
    ...fields,
    error: review.synthesisError,
    errorName: review.synthesisErrorName,
    durationMs: review.synthesisDurationMs,
    fallback: "publishing validated raw findings",
  });
}

/**
 * Reviews one pull request and publishes the result. Throws when the
 * pipeline fails outright (every agent produced invalid output) or the
 * publish step fails, leaving the retry decision to the caller.
 */
export async function reviewPullRequest(
  target: ReviewTarget,
  {
    client,
    runReviewPipeline,
    publishReview,
    logger = createConsoleLogger(),
  }: ReviewPullRequestDeps,
): Promise<ReviewPipelineResult> {
  const fields = reviewCorrelation(target);
  const ref = {
    owner: target.owner,
    repo: target.repo,
    pullRequestNumber: target.pullRequestNumber,
  };
  const [pullRequest, changedFiles, diff] = await Promise.all([
    client.getPullRequest(ref),
    client.listChangedFiles(ref),
    client.getDiff(ref),
  ]);
  logger.info("review.loaded", {
    ...fields,
    changedFileCount: changedFiles.length,
    diffLength: diff.length,
  });

  // The AI boundary: the pipeline's agent nodes only ever PROPOSE
  // candidate findings, and its synthesise node only ever REFINES
  // them. The validate node inside the pipeline is the deterministic
  // side-effect boundary — only its output ever reaches the GitHub
  // API, and only through application code below.
  const review = await runReviewPipeline(client, {
    owner: target.owner,
    repo: target.repo,
    pullRequest,
    changedFiles,
    diff,
  });
  // Failed lenses are noted in the check run by name only; the error
  // detail was already logged as agent.failed by the agent runtime at
  // failure time (see agent-runtime.ts) — this never re-emits it.
  logSynthesisOutcome(logger, target, review);

  logger.info("findings.validated", {
    ...fields,
    candidateCount: review.synthesisedCandidateCount,
    findingCount: review.findings.length,
  });

  const rendered = renderCheckRun(review.findings, review.agentFailures);
  const publish = publishReview ?? createCheckRunPublisher(client);
  await publish(target, rendered);

  logger.info("review.published", {
    ...fields,
    findingCount: review.findings.length,
  });

  return review;
}
