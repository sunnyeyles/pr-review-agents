/**
 * The review pipeline: agent fan-out, join, synthesis, deterministic
 * validation, and check-run rendering.
 */
export {
  runReviewPipeline,
  type AgentFailure,
  type ReviewPipelineResult,
} from "./review-graph.js";
export {
  SYNTHESIS_SYSTEM_PROMPT,
  SynthesisError,
  createSynthesiser,
  type SynthesisResult,
  type Synthesiser,
  type SynthesiserDeps,
} from "./synthesiser.js";
export { validateFindings } from "./validate-findings.js";
export { renderCheckRun, type RenderedCheckRun } from "./render-check-run.js";
export { renderReview, type RenderedReview } from "./render-review.js";
export {
  createCheckRunPublisher,
  createReviewCommentPublisher,
  reviewCorrelation,
  reviewPullRequest,
  type PublishReview,
  type PublishReviewComments,
  type ReviewPullRequestDeps,
  type ReviewTarget,
} from "./review-pull-request.js";
