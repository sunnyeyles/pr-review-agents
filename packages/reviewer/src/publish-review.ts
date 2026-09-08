/**
 * Delivery: one review across two GitHub surfaces. Comments go first; the
 * check run annotates only what no comment carries.
 */
import {
  httpStatus,
  isPermissionError,
  type GithubInstallationClient,
} from "@pr-review/github";
import type { StructuredLogger } from "@pr-review/logging";
import type { ReviewFinding } from "@pr-review/schemas";

import { applyFixes, type FixInput, type FixOutcome } from "./apply-fixes.js";
import { fixCount } from "./finding-format.js";
import {
  renderCheckRun,
  type RenderedCheckRun,
} from "./render-check-run.js";
import {
  renderReview,
  type RenderedReview,
  type ReviewNotes,
} from "./render-review.js";
import { reviewCorrelation, type ReviewTarget } from "./review-target.js";

/** What the comment publisher itself can report. */
type CommentsPublished = "posted" | "unavailable";

/** Why this commit's findings do or do not carry inline comments. */
type CommentsOutcome =
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

/** Delivers the verified patches as a commit on the pull request branch. */
export type PublishFixes = (
  target: ReviewTarget,
  input: FixInput,
) => Promise<FixOutcome>;

/** Everything one review has to say, before it is split across surfaces. */
interface ReviewDeliveryInput
  extends Pick<
    ReviewNotes,
    "agentFailures" | "alreadyPosted" | "skippedAgents" | "diffLines"
  > {
  findings: readonly ReviewFinding[];
  /** Verified patches: committed when a publisher can, offered otherwise. */
  patches?: FixInput | undefined;
}

interface ReviewDeliveryDeps {
  publishCheckRun: PublishReview;
  publishComments: PublishReviewComments;
  /** Absent when the run may not write to the branch. */
  publishFixes?: PublishFixes | undefined;
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

/** Commits the verified patches; the default writes to the head branch. */
export function createFixPublisher(
  client: GithubInstallationClient,
  logger: StructuredLogger,
): PublishFixes {
  return (target, input) => applyFixes(target, input, { client, logger });
}

/** How the review body reports the fixes; undefined when there were none. */
function fixNote(outcome: FixOutcome, patchCount: number): string | undefined {
  if (patchCount === 0) {
    return undefined;
  }
  if (outcome.status === "applied") {
    return `> **Note:** ${fixCount(patchCount)} committed to this branch as \`${outcome.sha.slice(0, 7)}\`.`;
  }
  if (outcome.status === "unavailable") {
    return `> **Note:** ${fixCount(patchCount)} could not be committed (${outcome.reason}), and ${patchCount === 1 ? "is" : "are"} offered as suggested changes below.`;
  }
  return `> **Note:** ${fixCount(patchCount)} offered as suggested changes below.`;
}

/** Fixes, then comments; the check run annotates only what nothing else carries. */
export async function deliverReview(
  target: ReviewTarget,
  input: ReviewDeliveryInput,
  deps: ReviewDeliveryDeps,
): Promise<void> {
  const fields = reviewCorrelation(target);
  const patchCount = input.patches?.patchCount ?? 0;

  let fixes: FixOutcome = { status: "skipped", reason: "fixes are not enabled" };
  if (input.patches !== undefined && deps.publishFixes !== undefined) {
    fixes = await deps.publishFixes(target, input.patches);
  }

  const review = renderReview(input.findings, {
    ...input,
    // A committed patch must not also arrive as a suggestion to apply again.
    offerSuggestions: fixes.status !== "applied",
    fixNote: fixNote(fixes, patchCount),
  });

  let comments: CommentsOutcome;
  if (review === undefined) {
    comments = input.findings.length === 0 ? "nothing-to-post" : "already-posted";
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
    skippedAgents: input.skippedAgents.map((skip) => skip.agent),
    comments,
    annotated,
    fixes: fixes.status,
    patchCount,
  });
}
