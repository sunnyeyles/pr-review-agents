/**
 * @pr-review/reviewer
 *
 * The review pipeline: the deterministic findings validation chain and
 * check-run rendering (this ticket), plus the orchestrator, review
 * agents (correctness, security, architecture), and synthesiser in
 * later tickets.
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
