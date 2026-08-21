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
  /**
   * Runs the LangGraph pipeline (agents -> join -> synthesise ->
   * validate). Throws when every agent failed, failing the workflow
   * step so the run can be retried from the Actions UI.
   */
  runReviewPipeline: (
    client: GithubInstallationClient,
    context: ReviewContext,
  ) => Promise<ReviewPipelineResult>;
  /**
   * Delivers the rendered review. In the entrypoint this is the
   * check-run publisher wrapped in the job-summary fallback; tests
   * inject a recording stub.
   */
  publishReview: PublishReview;
  logger?: StructuredLogger | undefined;
}

/**
 * What one Action run did. `reviewed: false` is a normal outcome — the
 * workflow fired on an event that is not a reviewable pull request —
 * and must not fail the step.
 */
export type ActionResult =
  | { reviewed: true }
  | { reviewed: false; reason: string };

export type ActionHandler = (
  payload: unknown,
  eventName: string,
) => Promise<ActionResult>;

/**
 * Builds the Action handler: inspect the workflow event, and if it is a
 * reviewable pull request, hand it to reviewPullRequest — the shared
 * body that loads the PR, runs the pipeline, and publishes the result.
 *
 * Only two things are specific to this delivery path, and both live
 * here and in event.ts: Actions event parsing and the ignore-quietly
 * rule.
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
