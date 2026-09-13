/**
 * The review pipeline: agent fan-out, join, deterministic validation, and
 * check-run rendering. The synthesiser lives in @pr-review/ai.
 */
export {
  runReviewPipeline,
  type ReviewPipelineResult,
} from "./review-pipeline.js";
export { validateFindings } from "./validate-findings.js";
export type { RenderedCheckRun } from "./render-check-run.js";
export {
  createCheckRunPublisher,
  type PublishReview,
  type PublishReviewComments,
} from "./publish-review.js";
export { reviewPullRequest } from "./review-pull-request.js";
export {
  learnFromMergedPullRequest,
  type LearnFromMergeDeps,
} from "./learn-from-merge.js";
export {
  computeHints,
  createBranchMemoryStore,
  emptyMemory,
  MEMORY_FILE_PATH,
  readMemory,
  recordSignals,
  titleShape,
  writeMemory,
  HINT_CAP,
  HINT_IGNORED_THRESHOLD,
  MEMORY_TTL_DAYS,
  type FindingOutcome,
  type FindingSignal,
  type MemoryStore,
} from "./memory.js";
export {
  categoryMarker,
  findingMarker,
  parsePostedFinding,
  postedFindingKeys,
  renderReview,
  type PostedFinding,
  type RenderedReview,
  type ReviewNotes,
} from "./render-review.js";
export { reviewCorrelation, type ReviewTarget } from "./review-target.js";
