/**
 * The three review lenses. Each differs ONLY in its review focus and
 * (for Architecture) extra context guidance; the agentic loop, the six
 * read-only tools, the prompt-injection hardening, and the output
 * contract live once in agent-runtime.ts.
 */
import {
  createReviewAgent,
  type ReviewAgentDeps,
  type ReviewLens,
} from "./agent-runtime.js";
import type { ReviewAgent } from "./review-types.js";

/** The Correctness lens. */
export const correctnessLens: ReviewLens = {
  category: "correctness",
  role: "Correctness reviewer",
  focus: `Review the pull request ONLY for correctness problems:
- bugs and incorrect logic
- missing validation
- error-handling problems
- unhandled edge cases
- async issues (unawaited promises, race conditions, missing error propagation)
- incorrect state changes
Do NOT report formatting, style, naming preferences, or architectural opinions — those are out of scope for you and will be discarded.`,
};

/** The Security lens. */
export const securityLens: ReviewLens = {
  category: "security",
  role: "Security reviewer",
  focus: `Review the pull request ONLY for security problems:
- authentication issues (missing, weakened, or bypassable checks)
- authorisation issues (missing ownership or role checks)
- cross-tenant access (data reachable across tenant boundaries)
- injection (SQL/NoSQL, command, path, template, or header injection)
- secret leakage (credentials, tokens, or keys exposed in code, configuration, or responses)
- unsafe handling of user input (unvalidated, unsanitised, or blindly trusted input)
- sensitive data written to logs (credentials, tokens, personal data)
- privilege issues (privilege escalation, over-broad permissions)
Do NOT report correctness bugs, formatting, style, or architectural opinions — those are out of scope for you and will be discarded.
A security finding is a serious accusation. Report one ONLY when the code in front of you demonstrates the problem: prefer NO finding over a speculative one.`,
};

/** The Architecture lens. */
export const architectureLens: ReviewLens = {
  category: "architecture",
  role: "Architecture reviewer",
  focus: `Review the pull request ONLY for architectural problems:
- incorrect abstractions
- duplicated functionality (reimplementing something the repository already provides)
- bad dependencies (wrong direction, needless coupling, unsuitable libraries)
- package or module boundary violations
- existing patterns in the repository that the change ignores or should have reused
- business logic placed in the wrong layer
Do NOT report correctness bugs, security issues, formatting, or style — those are out of scope for you and will be discarded.`,
  contextGuidance: `Architectural claims require evidence beyond the diff. You MUST retrieve surrounding repository context with the tools BEFORE making any architectural claim: use get_file to read how neighbouring modules and layers are structured, and search_repository to find existing patterns, duplicated functionality, or the place where the logic already lives. If the surrounding context you retrieved does not support the claim, do not report it.`,
};

/** The lenses in order — the set every review runs. */
export const reviewLenses = [
  correctnessLens,
  securityLens,
  architectureLens,
] as const;

/**
 * Builds all three review agents over one installation's GitHub client
 * — the set the orchestrator runs concurrently per review job.
 */
export function createReviewAgents(deps: ReviewAgentDeps): ReviewAgent[] {
  return reviewLenses.map((lens) => createReviewAgent(lens, deps));
}
