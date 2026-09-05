/**
 * Delivery: one review across two GitHub surfaces. Comments go first; the
 * check run annotates only what no comment carries.
 */
import { skippedAgentNames, type SkippedAgent } from "@pr-review/ai";
import {
  httpStatus,
  isPermissionError,
  type GithubInstallationClient,
} from "@pr-review/github";
import type { StructuredLogger } from "@pr-review/logging";
import type { ReviewFinding } from "@pr-review/schemas";

import {
  renderCheckRun,
  type RenderedCheckRun,
} from "./render-check-run.js";
import {
  nothingPostedReason,
  renderReview,
  type RenderedReview,
} from "./render-review.js";
import type { AgentFailure } from "./review-pipeline.js";
import { reviewCorrelation, type ReviewTarget } from "./review-target.js";

/** What the comment publisher itself can report. */
export type CommentsPublished = "posted" | "unavailable";

/** Why this commit's findings do or do not carry inline comments. */
export type CommentsOutcome =
  | CommentsPublished
  /** Every finding was already commented on an earlier commit. */
  | "already-posted"
  /** There was nothing to say. */
  | "nothing-to-post";

/** Delivers the rendered review; the default publishes a check run. */
export type PublishReview = (
  target: ReviewTarget,
  rendered: RenderedCheckRun,
) => Promise<void>;

/** Delivers the inline review comments, naming what happened to them. */
export type PublishReviewComments = (
  target: ReviewTarget,
  rendered: RenderedReview,
) => Promise<CommentsPublished>;

/** Everything one review has to say, before it is split across surfaces. */
interface ReviewDeliveryInput {
  findings: readonly ReviewFinding[];
  agentFailures: readonly AgentFailure[];
  skippedAgents: readonly SkippedAgent[];
  /** Finding keys already carrying a comment from an earlier commit. */
  alreadyPosted: ReadonlySet<string>;
}

interface ReviewDeliveryDeps {
  publishCheckRun: PublishReview;
  publishComments: PublishReviewComments;
  logger: StructuredLogger;
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
 * One advisory review on the head SHA. A fork's token lacks
 * `pull-requests: write`, so a permission failure must not stop the check run.
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
      return "posted";
    } catch (error) {
      // Only a permission error degrades; anything else is a real bug.
      if (!isPermissionError(error)) {
        throw error;
      }
      logger.info("review.comments.degraded", {
        ...reviewCorrelation(target),
        reason: "workflow token cannot post review comments",
        status: httpStatus(error),
      });
      return "unavailable";
    }
  };
}

/** Comments first; the check run annotates only what nothing else carries. */
export async function deliverReview(
  target: ReviewTarget,
  input: ReviewDeliveryInput,
  deps: ReviewDeliveryDeps,
): Promise<void> {
  const fields = reviewCorrelation(target);
  const review = renderReview(
    input.findings,
    input.agentFailures,
    input.alreadyPosted,
    input.skippedAgents,
  );

  let comments: CommentsOutcome;
  if (review === undefined) {
    comments = nothingPostedReason(input.findings);
  } else {
    comments = await deps.publishComments(target, review);
    if (comments === "posted") {
      const commentCount = review.comments.length;
      deps.logger.info("review.comments.published", {
        ...fields,
        commentCount,
        carriedInBodyCount: input.findings.length - commentCount,
      });
    }
  }

  // Annotations are the fallback surface only; an earlier commit's comments
  // still carry their findings.
  const annotated = comments === "unavailable";
  await deps.publishCheckRun(
    target,
    renderCheckRun(input.findings, input.agentFailures, {
      annotate: annotated,
      skippedAgents: input.skippedAgents,
    }),
  );

  deps.logger.info("review.published", {
    ...fields,
    findingCount: input.findings.length,
    skippedAgents: skippedAgentNames(input.skippedAgents),
    comments,
    annotated,
  });
}
