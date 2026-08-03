/**
 * @pr-review/reviewer
 *
 * The review pipeline: the orchestrator that runs the review agents
 * over a loaded PR context, the AI Synthesiser that refines their raw
 * candidates (spec §16), the deterministic findings validation chain,
 * and check-run rendering.
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
  runReview,
  type AgentFailure,
  type ReviewRunResult,
} from "./orchestrator.js";
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
