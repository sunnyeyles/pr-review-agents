/**
 * One review, end to end: load PR -> runReviewPipeline -> renderCheckRun
 * -> publish. The side-effect boundary is enforced here, once, rather
 * than in each delivery-path wrapper.
 */
import {
  emptyTokenUsage,
  gateAgentsByPaths,
  type AgentDefinition,
  type ReviewContext,
  type SkippedAgent,
} from "@pr-review/ai";
import {
  httpStatus,
  isPermissionError,
  type ExistingReviewComment,
  type GithubInstallationClient,
  type PullRequestRef,
} from "@pr-review/github";
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import {
  renderCheckRun,
  renderNoAgentMatched,
  type RenderedCheckRun,
} from "./render-check-run.js";
import {
  postedFindingKeys,
  renderReview,
  type RenderedReview,
} from "./render-review.js";
import type { ReviewPipelineResult } from "./review-graph.js";

/** The pull request one review runs against. */
export interface ReviewTarget {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
}

/** Delivers the rendered review; the default publishes a check run. */
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
  /** The run's agent set, already narrowed by the `agents` input. */
  agents: readonly AgentDefinition[];
  /**
   * Whether an agent's `paths` decide if it runs. Defaults to true; the
   * caller sets it false when someone named the agents explicitly.
   */
  applyPathFilters?: boolean | undefined;
  /** Throws only when every agent failed; a synthesis failure is reported on the result. */
  runReviewPipeline: (
    client: GithubInstallationClient,
    context: ReviewContext,
    agents: readonly AgentDefinition[],
  ) => Promise<ReviewPipelineResult>;
  /** Defaults to publishing a check run through `client`. */
  publishReview?: PublishReview | undefined;
  /** Defaults to publishing a review through `client`. */
  publishReviewComments?: PublishReviewComments | undefined;
  /** Every event carries repository, PR number, and head SHA. */
  logger?: StructuredLogger | undefined;
}

/** The correlation fields every event of one review carries. */
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
 * head SHA. A failure is swallowed — publishing comments needs
 * `pull-requests: write`, which a fork's token lacks, and the check run
 * must still be published.
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
      // Only a permission error degrades: a fork's token cannot post
      // comments. Anything else is rethrown, so a real bug here fails
      // the run instead of silently falling back forever.
      if (!isPermissionError(error)) {
        throw error;
      }
      logger.info("review.comments.degraded", {
        ...reviewCorrelation(target),
        reason: "workflow token cannot post review comments",
        status: httpStatus(error),
      });
      return false;
    }
  };
}

/** The comments already on the pull request; none if they cannot be read. */
async function listPostedComments(
  client: GithubInstallationClient,
  ref: PullRequestRef,
  target: ReviewTarget,
  logger: StructuredLogger,
): Promise<ExistingReviewComment[]> {
  try {
    return await client.listReviewComments(ref);
  } catch (error) {
    logger.error("review.comments.list_failed", {
      ...reviewCorrelation(target),
      reason: errorMessage(error),
      fallback: "publishing every finding, which may repeat an earlier one",
    });
    return [];
  }
}

/** Logs the synthesis outcome: skipped, completed, or failed. */
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

/** A review's pipeline result, plus the agents the path gate held back. */
export interface ReviewOutcome extends ReviewPipelineResult {
  skippedAgents: SkippedAgent[];
}

/** The result of a review that never reached the pipeline. */
function unreviewed(skippedAgents: SkippedAgent[]): ReviewOutcome {
  return {
    candidates: [],
    agentFailures: [],
    synthesisedCandidateCount: 0,
    synthesisOutcome: "skipped",
    synthesisUsage: emptyTokenUsage(),
    findings: [],
    skippedAgents,
  };
}

/** Throws when the pipeline or the publish step fails; retries are the caller's. */
export async function reviewPullRequest(
  target: ReviewTarget,
  {
    client,
    agents,
    applyPathFilters = true,
    runReviewPipeline,
    publishReview,
    publishReviewComments,
    logger = createConsoleLogger(),
  }: ReviewPullRequestDeps,
): Promise<ReviewOutcome> {
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

  // A gate, not a narrowing: the agents this wakes still review the
  // whole pull request, on the same context and the same prompts.
  const { active, skipped } = applyPathFilters
    ? gateAgentsByPaths(
        agents,
        changedFiles.map((file) => file.filename),
      )
    : { active: [...agents], skipped: [] };
  const skippedNames = skipped.map((skip) => skip.agent);
  for (const skip of skipped) {
    logger.info("agent.skipped", {
      ...fields,
      agent: skip.agent,
      paths: skip.paths,
      reason: "no changed file matched",
    });
  }

  const publish = publishReview ?? createCheckRunPublisher(client);
  if (active.length === 0) {
    // Publishing is not optional here. An unreviewed pull request with
    // no check run at all is the silent narrowing this must never be.
    logger.info("review.no_agents_matched", {
      ...fields,
      changedFileCount: changedFiles.length,
      skippedAgents: skippedNames,
    });
    await publish(
      target,
      renderNoAgentMatched(
        skipped,
        changedFiles.map((file) => file.filename),
      ),
    );
    return unreviewed(skipped);
  }

  // The AI boundary: only the validate node's output reaches GitHub.
  const review = await runReviewPipeline(
    client,
    {
      owner: target.owner,
      repo: target.repo,
      pullRequest,
      changedFiles,
      diff,
    },
    active,
  );
  logSynthesisOutcome(logger, target, review);

  logger.info("findings.validated", {
    ...fields,
    candidateCount: review.synthesisedCandidateCount,
    findingCount: review.findings.length,
  });

  // Inline comments go first: whether they landed decides whether the
  // check run repeats them as annotations against the same lines.
  const reviewComments = renderReview(
    review.findings,
    review.agentFailures,
    postedFindingKeys(await listPostedComments(client, ref, target, logger)),
    skipped,
  );
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
    skippedAgents: skipped,
  });
  await publish(target, rendered);

  logger.info("review.published", {
    ...fields,
    findingCount: review.findings.length,
    skippedAgents: skippedNames,
  });

  return { ...review, skippedAgents: skipped };
}
