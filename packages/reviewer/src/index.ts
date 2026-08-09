/**
 * @pr-review/reviewer
 *
 * The review pipeline: a LangGraph StateGraph that fans the review
 * agents out over a loaded PR context, joins their candidates with
 * spec §20 partial-failure semantics, refines them through the AI
 * Synthesiser (spec §16), and runs the deterministic findings
 * validation chain (spec §17) — plus check-run rendering.
 */
import { AI_PACKAGE } from "@pr-review/ai";
import { GITHUB_PACKAGE } from "@pr-review/github";
import { SCHEMAS_PACKAGE } from "@pr-review/schemas";

export const REVIEWER_PACKAGE = "@pr-review/reviewer";

export const reviewerPackageDependencies = [
  SCHEMAS_PACKAGE,
  GITHUB_PACKAGE,
  AI_PACKAGE,
] as const;

export { buildChangedLineIndex, changedLinesFromPatch } from "./diff-lines.js";
export {
  buildReviewGraph,
  runReviewPipeline,
  type AgentFailure,
  type ReviewPipelineResult,
} from "./review-graph.js";
export {
  SYNTHESIS_SYSTEM_PROMPT,
  SynthesisError,
  buildSynthesisMessage,
  createSynthesiser,
  type SynthesisResult,
  type Synthesiser,
  type SynthesiserDeps,
} from "./synthesiser.js";
export {
  CONFIDENCE_THRESHOLD,
  MAX_FINDINGS,
  compareFindingStrength,
  validateFindings,
} from "./validate-findings.js";
export {
  MAX_ANNOTATIONS_PER_REQUEST,
  renderCheckRun,
  type RenderedCheckRun,
} from "./render-check-run.js";
