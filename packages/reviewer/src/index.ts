/**
 * The review pipeline: agent fan-out, join, deterministic validation,
 * and check-run rendering. The synthesiser lives in @pr-review/ai.
 */
export {
  runReviewPipeline,
  type AgentFailure,
  type ReviewPipelineResult,
} from "./review-graph.js";
export { validateFindings } from "./validate-findings.js";
export { renderCheckRun, type RenderedCheckRun } from "./render-check-run.js";
export {
  feedbackMarker,
  parseFeedbackMarker,
  parseFindingMarker,
  renderReview,
  type FeedbackMeta,
  type RenderedReview,
} from "./render-review.js";
export {
  canPush,
  collectFeedback,
  type CollectFeedbackOptions,
  type CollectFeedbackReport,
} from "./collect-feedback.js";
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
