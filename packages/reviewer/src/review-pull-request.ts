/**
 * One review, end to end:
 *
 *   load PR -> runReviewPipeline -> renderCheckRun -> publish
 *
 * with a lifecycle log line at each step (spec §26).
 *
 * This is the shared body, kept separate from the delivery path that
 * triggers it. It owns the publish step deliberately: the side-effect
 * boundary (spec §17) is enforced here, once, not in each wrapper.
 *
 * Outside its scope: authentication and retries, both the caller's.
 */
import type { ReviewContext } from "@pr-review/ai";
import type { GithubInstallationClient } from "@pr-review/github";
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import { renderCheckRun, type RenderedCheckRun } from "./render-check-run.js";
import { renderReview, type RenderedReview } from "./render-review.js";
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

/**
 * Delivers the inline review comments, reporting whether they landed.
 * A false return is not an error: the findings are still published on
 * the check run, which keeps its annotations precisely because the
 * comments did not appear.
 */
export type PublishReviewComments = (
  target: ReviewTarget,
  rendered: RenderedReview,
) => Promise<boolean>;

export interface ReviewPullRequestDeps {
  /** Authenticated read-only GitHub client for this repository. */
  client: GithubInstallationClient;
  /**
   * Runs the LangGraph pipeline: agents fan out over the loaded PR
   * context, the Synthesiser refines their raw candidates, and the
   * deterministic chain validates what survives.
   *
   * Throws only when every agent failed, so callers apply their own
   * retry semantics. A synthesis failure never throws — it is reported
   * on the result and the raw candidates are published instead.
   */
  runReviewPipeline: (
    client: GithubInstallationClient,
    context: ReviewContext,
  ) => Promise<ReviewPipelineResult>;
  /** Defaults to publishing a check run through `client`. */
  publishReview?: PublishReview | undefined;
  /** Defaults to publishing a review through `client`. */
  publishReviewComments?: PublishReviewComments | undefined;
  /**
   * Structured lifecycle logger (spec §26). Every event carries
   * repository, PR number, and head SHA, so an operator can answer
   * "what happened to the review for PR N?" from the logs alone.
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
 * The default delivery for inline comments: one advisory review on the
 * head SHA.
 *
 * A failure here is swallowed rather than thrown. Publishing comments
 * needs `pull-requests: write`, which a fork pull request's token does
 * not carry, and a review that cannot be commented on must still be
 * published as a check run rather than lost.
 */
export function createReviewCommentPublisher(
  client: GithubInstallationClient,
  logger: StructuredLogger,
): PublishReviewComments {
  return async (target, rendered) => {
    try {
      await client.createReview({
        owner: target.owner,
        repo: target.repo,
        pullRequestNumber: target.pullRequestNumber,
        commitSha: target.headSha,
        body: rendered.body,
        comments: rendered.comments,
      });
      return true;
    } catch (error) {
      logger.error("review.comments.failed", {
        ...reviewCorrelation(target),
        reason: errorMessage(error),
      });
      return false;
    }
  };
}

/**
 * Logs the synthesis outcome the pipeline already computed — one of
 * skipped (no candidates), completed, or failed. A failure notes the
 * fallback: the raw candidates still flow through validateFindings, so
 * the review never dies from a synthesis failure.
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
      ...review.synthesisUsage,
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
    publishReviewComments,
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

  // The AI boundary. Agent nodes only PROPOSE candidates; the
  // synthesise node only REFINES them. Only the validate node's output
  // (review.findings) ever reaches the GitHub API, via the code below.
  const review = await runReviewPipeline(client, {
    owner: target.owner,
    repo: target.repo,
    pullRequest,
    changedFiles,
    diff,
  });
  // Failed lenses reach the check run by name only; agent-runtime.ts
  // already logged the error detail as agent.failed.
  logSynthesisOutcome(logger, target, review);

  logger.info("findings.validated", {
    ...fields,
    candidateCount: review.synthesisedCandidateCount,
    findingCount: review.findings.length,
  });

  // Inline comments go first: whether they landed decides whether the
  // check run repeats them as annotations against the same lines.
  const reviewComments = renderReview(review.findings, review.agentFailures);
  const publishComments =
    publishReviewComments ?? createReviewCommentPublisher(client, logger);
  const commented =
    reviewComments === undefined
      ? false
      : await publishComments(target, reviewComments);

  if (commented && reviewComments !== undefined) {
    logger.info("review.comments.published", {
      ...fields,
      commentCount: reviewComments.comments.length,
      carriedInBodyCount:
        review.findings.length - reviewComments.comments.length,
    });
  }

  const rendered = renderCheckRun(review.findings, review.agentFailures, {
    annotate: !commented,
  });
  const publish = publishReview ?? createCheckRunPublisher(client);
  await publish(target, rendered);

  logger.info("review.published", {
    ...fields,
    findingCount: review.findings.length,
  });

  return review;
}
