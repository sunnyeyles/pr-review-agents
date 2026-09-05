/**
 * The review pipeline: agent fan-out, join, deterministic validation,
 * and check-run rendering. The synthesiser lives in @pr-review/ai.
 *
 * A name reaches this barrel when something outside the package imports
 * it; everything else stays reachable by its own module path.
 */
export {
  runReviewPipeline,
  type ReviewPipelineResult,
} from "./review-graph.js";
export { validateFindings } from "./validate-findings.js";
export type { RenderedCheckRun } from "./render-check-run.js";
export {
  createCheckRunPublisher,
  type PublishReview,
} from "./publish-review.js";
export { reviewPullRequest } from "./review-pull-request.js";
export { reviewCorrelation, type ReviewTarget } from "./review-target.js";
