import type { AgentDefinition, ReviewContext } from "@pr-review/ai";
import type { GithubInstallationClient } from "@pr-review/github";
import { createConsoleLogger, type StructuredLogger } from "@pr-review/logging";
import {
  reviewCorrelation,
  reviewPullRequest,
  type PublishReview,
  type ReviewPipelineResult,
  type ReviewTarget,
} from "@pr-review/reviewer";

export interface ActionHandlerDeps {
  /** Token-authenticated read-only client for this repository. */
  client: GithubInstallationClient;
  /** The run's agent set, already narrowed by the `agents` input. */
  agents: readonly AgentDefinition[];
  /** False when the `agents` input named agents explicitly. */
  applyPathFilters?: boolean | undefined;
  /** Throws when every agent failed, so the workflow step fails and can be re-run. */
  runReviewPipeline: (
    client: GithubInstallationClient,
    context: ReviewContext,
    agents: readonly AgentDefinition[],
  ) => Promise<ReviewPipelineResult>;
  /** In the entrypoint, the check-run publisher wrapped in the job-summary fallback. */
  publishReview: PublishReview;
  logger?: StructuredLogger | undefined;
}

export type ActionHandler = (
  target: ReviewTarget,
  isFork: boolean,
) => Promise<void>;

/**
 * Reviews the pull request the entrypoint's event inspection produced.
 * Whether an event is reviewable is decided before this, because the agent
 * configuration is read from that pull request's base commit.
 */
export function createActionHandler({
  client,
  agents,
  applyPathFilters,
  runReviewPipeline,
  publishReview,
  logger = createConsoleLogger(),
}: ActionHandlerDeps): ActionHandler {
  return async (target, isFork) => {
    logger.info("review.started", { ...reviewCorrelation(target), isFork });
    await reviewPullRequest(target, {
      client,
      agents,
      applyPathFilters,
      runReviewPipeline,
      publishReview,
      logger,
    });
  };
}
