import type { ReviewContext } from "@pr-review/ai";
import type { GithubInstallationClient } from "@pr-review/github";
import { createConsoleLogger, type StructuredLogger } from "@pr-review/logging";
import {
  reviewCorrelation,
  reviewPullRequest,
  type PublishReview,
  type ReviewPipelineResult,
} from "@pr-review/reviewer";

import { inspectEvent } from "./event.js";

export interface ActionHandlerDeps {
  /** Token-authenticated read-only client for this repository. */
  client: GithubInstallationClient;
  /** Throws when every agent failed, so the workflow step fails and can be re-run. */
  runReviewPipeline: (
    client: GithubInstallationClient,
    context: ReviewContext,
  ) => Promise<ReviewPipelineResult>;
  /** In the entrypoint, the check-run publisher wrapped in the job-summary fallback. */
  publishReview: PublishReview;
  logger?: StructuredLogger | undefined;
}

/** `reviewed: false` is a normal outcome and must not fail the step. */
export type ActionResult =
  | { reviewed: true }
  | { reviewed: false; reason: string };

export type ActionHandler = (
  payload: unknown,
  eventName: string,
) => Promise<ActionResult>;

/**
 * Inspects the workflow event and hands a reviewable pull request to
 * reviewPullRequest. Only the event parsing and the ignore-quietly rule
 * are specific to this delivery path.
 */
export function createActionHandler({
  client,
  runReviewPipeline,
  publishReview,
  logger = createConsoleLogger(),
}: ActionHandlerDeps): ActionHandler {
  return async (payload, eventName) => {
    const inspection = inspectEvent(payload, eventName);
    if (!inspection.review) {
      logger.info("review.skipped", { reason: inspection.reason });
      return { reviewed: false, reason: inspection.reason };
    }

    const { target, isFork } = inspection;
    logger.info("review.started", { ...reviewCorrelation(target), isFork });
    await reviewPullRequest(target, {
      client,
      runReviewPipeline,
      publishReview,
      logger,
    });
    return { reviewed: true };
  };
}
