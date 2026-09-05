/**
 * One review, end to end: load PR -> runReviewPipeline -> deliverReview.
 * The side-effect boundary is enforced here, once, rather than in each
 * delivery-path wrapper.
 */
import {
  gateAgentsByPaths,
  type AgentDefinition,
  type ReviewContext,
} from "@pr-review/ai";
import type {
  ExistingReviewComment,
  GithubInstallationClient,
  PullRequestRef,
} from "@pr-review/github";
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import {
  createCheckRunPublisher,
  createReviewCommentPublisher,
  deliverReview,
  type PublishReview,
  type PublishReviewComments,
} from "./publish-review.js";
import { renderNoAgentMatched } from "./render-check-run.js";
import { postedFindingKeys } from "./render-review.js";
import {
  skippedSynthesis,
  type ReviewPipelineResult,
} from "./review-graph.js";
import { reviewCorrelation, type ReviewTarget } from "./review-target.js";

interface ReviewPullRequestDeps {
  /** Authenticated read-only GitHub client for this repository. */
  client: GithubInstallationClient;
  /** The run's agent set, already narrowed by the `agents` input. */
  agents: readonly AgentDefinition[];
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
  const { synthesis } = review;
  if (synthesis.outcome === "skipped") {
    logger.info("synthesis.skipped", { ...fields, reason: "no candidate findings" });
    return;
  }

  logger.info("synthesis.started", {
    ...fields,
    candidateCount: review.candidates.length,
  });
  if (synthesis.outcome === "completed") {
    logger.info("synthesis.completed", {
      ...fields,
      candidateCount: review.candidates.length,
      refinedCount: synthesis.candidates.length,
      ...synthesis.usage,
      durationMs: synthesis.durationMs,
    });
    return;
  }

  logger.error("synthesis.failed", {
    ...fields,
    error: synthesis.error,
    errorName: synthesis.errorName,
    durationMs: synthesis.durationMs,
    fallback: "publishing validated raw findings",
  });
}

/** The result of a review that never reached the pipeline. */
function unreviewed(): ReviewPipelineResult {
  return {
    candidates: [],
    agentFailures: [],
    synthesis: skippedSynthesis(),
    findings: [],
  };
}

/** Throws when the pipeline or the publish step fails; retries are the caller's. */
export async function reviewPullRequest(
  target: ReviewTarget,
  {
    client,
    agents,
    runReviewPipeline,
    publishReview,
    publishReviewComments,
    logger = createConsoleLogger(),
  }: ReviewPullRequestDeps,
): Promise<ReviewPipelineResult> {
  const fields = reviewCorrelation(target);
  const ref: PullRequestRef = {
    owner: target.owner,
    repo: target.repo,
    pullRequestNumber: target.pullRequestNumber,
  };
  const [pullRequest, changedFiles, diff] = await Promise.all([
    client.getPullRequest(ref),
    client.listChangedFiles(ref),
    client.getDiff(ref),
  ]);
  const filenames = changedFiles.map((file) => file.filename);
  logger.info("review.loaded", {
    ...fields,
    changedFileCount: changedFiles.length,
    diffLength: diff.length,
  });

  const { active, skipped } = gateAgentsByPaths(agents, filenames);
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
    logger.info("review.no_agents_matched", {
      ...fields,
      changedFileCount: changedFiles.length,
      skippedAgents: skippedNames,
    });
    await publish(target, renderNoAgentMatched(skipped, filenames));
    return unreviewed();
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
    candidateCount: review.synthesis.candidates.length,
    findingCount: review.findings.length,
  });

  await deliverReview(
    target,
    {
      findings: review.findings,
      agentFailures: review.agentFailures,
      skippedAgents: skipped,
      alreadyPosted: postedFindingKeys(
        await listPostedComments(client, ref, target, logger),
      ),
    },
    {
      publishCheckRun: publish,
      publishComments:
        publishReviewComments ?? createReviewCommentPublisher(client, logger),
      logger,
    },
  );

  return review;
}
