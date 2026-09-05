/**
 * The review pipeline: agent fan-out, join, deterministic validation, and
 * check-run rendering. The synthesiser lives in @pr-review/ai.
 */
export {
  runReviewPipeline,
  type ReviewPipelineResult,
} from "./review-graph.js";
export { validateFindings } from "./validate-findings.js";
export type { RenderedCheckRun } from "./render-check-run.js";
export {
  createCheckRunPublisher,
  reviewCorrelation,
  reviewPullRequest,
  type PublishReview,
  type ReviewTarget,
} from "./review-pull-request.js";
