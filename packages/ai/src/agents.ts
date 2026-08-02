/**
 * The three review lenses (spec §9, §10, §11) as thin factories over
 * the shared agent runtime. Each lens differs ONLY in its review focus
 * and (for Architecture) extra context guidance; the agentic loop, the
 * six read-only tools, the §21 prompt-injection hardening, and the §15
 * output contract are identical by construction — they live once in
 * agent-runtime.ts.
 */
import {
  buildReviewSystemPrompt,
  createReviewAgent,
  type ReviewAgentDeps,
  type ReviewLens,
} from "./agent-runtime.js";
import type { ReviewAgent } from "./review-types.js";

/** The Correctness lens (spec §9). */
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

/** The Security lens (spec §10). */
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

/** The Architecture lens (spec §11). */
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

export const CORRECTNESS_SYSTEM_PROMPT = buildReviewSystemPrompt(correctnessLens);
export const SECURITY_SYSTEM_PROMPT = buildReviewSystemPrompt(securityLens);
export const ARCHITECTURE_SYSTEM_PROMPT = buildReviewSystemPrompt(architectureLens);

/** Builds the Correctness agent for one installation's GitHub client. */
export function createCorrectnessAgent(deps: ReviewAgentDeps): ReviewAgent {
  return createReviewAgent(correctnessLens, deps);
}

/** Builds the Security agent for one installation's GitHub client. */
export function createSecurityAgent(deps: ReviewAgentDeps): ReviewAgent {
  return createReviewAgent(securityLens, deps);
}

/** Builds the Architecture agent for one installation's GitHub client. */
export function createArchitectureAgent(deps: ReviewAgentDeps): ReviewAgent {
  return createReviewAgent(architectureLens, deps);
}

/**
 * Builds all three review agents (spec §8 order: Correctness,
 * Security, Architecture) over one installation's GitHub client — the
 * set the orchestrator runs concurrently per review job.
 */
export function createReviewAgents(deps: ReviewAgentDeps): ReviewAgent[] {
  return [
    createCorrectnessAgent(deps),
    createSecurityAgent(deps),
    createArchitectureAgent(deps),
  ];
}
