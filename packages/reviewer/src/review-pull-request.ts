/**
 * One review, end to end. The side-effect boundary is enforced here, once,
 * rather than in each delivery-path wrapper.
 */
import {
  gateAgentsByPaths,
  type AgentDefinition,
  type ReviewContext,
} from "@pr-review/ai";
import type {
  ExistingReviewComment,
  GithubInstallationClient,
} from "@pr-review/github";
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import { buildDiffLineIndex } from "./diff-lines.js";
import {
  createCheckRunPublisher,
  createFixPublisher,
  createReviewCommentPublisher,
  deliverReview,
  type PublishFixes,
  type PublishReview,
  type PublishReviewComments,
} from "./publish-review.js";
import { renderNoAgentMatched } from "./render-check-run.js";
import { verifyPatches, type PatchSummary } from "./validate-patches.js";
import { postedFindingKeys } from "./render-review.js";
import {
  skippedSynthesis,
  type ReviewPipelineResult,
} from "./review-pipeline.js";
import { reviewCorrelation, type ReviewTarget } from "./review-target.js";

interface ReviewPullRequestDeps {
  /** Authenticated GitHub client for this repository. */
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
  /** Whether verified patches may be committed to the head branch. */
  applyFixes?: boolean | undefined;
  /** Defaults to committing through `client`, when applyFixes is on. */
  publishFixes?: PublishFixes | undefined;
  /** Every event carries repository, PR number, and head SHA. */
  logger?: StructuredLogger | undefined;
}

/** The comments already on the pull request; none if they cannot be read. */
async function listPostedComments(
  client: GithubInstallationClient,
  target: ReviewTarget,
  logger: StructuredLogger,
): Promise<ExistingReviewComment[]> {
  try {
    return await client.listReviewComments(target);
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

/** One review's outcome, plus how the patches its agents proposed fared. */
export interface ReviewOutcome extends ReviewPipelineResult {
  patches: PatchSummary;
}

/** The result of a review that never reached the pipeline. */
function unreviewed(): ReviewOutcome {
  return {
    candidates: [],
    agentFailures: [],
    synthesis: skippedSynthesis(),
    findings: [],
    patches: { proposed: 0, verified: 0 },
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
    applyFixes = false,
    publishFixes,
    logger = createConsoleLogger(),
  }: ReviewPullRequestDeps,
): Promise<ReviewOutcome> {
  const fields = reviewCorrelation(target);
  const [pullRequest, changedFiles, diff] = await Promise.all([
    client.getPullRequest(target),
    client.listChangedFiles(target),
    client.getDiff(target),
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

  // The AI boundary: only the validate step's output reaches GitHub.
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

  // Still inside the AI boundary: a patch is proved against the head commit
  // before any of it can be committed or offered.
  const verified = await verifyPatches(review.findings, changedFiles, {
    client,
    owner: target.owner,
    repo: target.repo,
    headSha: target.headSha,
  });
  logger.info("patches.verified", {
    ...fields,
    proposedCount: verified.summary.proposed,
    verifiedCount: verified.summary.verified,
    files: verified.files.map((file) => file.path),
  });

  await deliverReview(
    target,
    {
      findings: verified.findings,
      agentFailures: review.agentFailures,
      skippedAgents: skipped,
      diffLines: buildDiffLineIndex(changedFiles),
      patches: {
        branch: pullRequest.headRef,
        files: verified.files,
        patchCount: verified.patchCount,
      },
      alreadyPosted: postedFindingKeys(
        await listPostedComments(client, target, logger),
      ),
    },
    {
      publishCheckRun: publish,
      publishComments:
        publishReviewComments ?? createReviewCommentPublisher(client, logger),
      ...(applyFixes
        ? { publishFixes: publishFixes ?? createFixPublisher(client, logger) }
        : {}),
      logger,
    },
  );

  return { ...review, findings: verified.findings, patches: verified.summary };
}
