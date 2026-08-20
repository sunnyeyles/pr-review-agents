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

/** The lenses in order — the set a review runs unless narrowed. */
export const reviewLenses = [
  correctnessLens,
  securityLens,
  architectureLens,
] as const;

/** The value selecting every lens, and the default when none is given. */
export const ALL_LENSES = "all";

/**
 * Resolves the `agents` input — a comma-separated list of lens
 * categories, or `all` — into the lenses to run.
 *
 * Narrowing the set is the point: one lens costs roughly a third of a
 * full review, and iterating on the architecture prompt does not need
 * correctness and security running alongside it.
 *
 * Three deliberate choices:
 *
 * - The result is in `reviewLenses` order, never the caller's. Agent
 *   order decides candidate order in `join` and therefore the order
 *   findings reach the synthesiser, so it must not depend on how the
 *   input happened to be typed.
 * - Duplicates collapse. `correctness,correctness` asking for two
 *   identical agents is a typo, not a request.
 * - An unknown name throws rather than being ignored. A silently
 *   dropped `--agents security` would run a review that reports
 *   nothing and looks like a clean bill of health.
 */
export function resolveReviewLenses(selection: string): ReviewLens[] {
  const trimmed = selection.trim();
  if (trimmed === "" || trimmed.toLowerCase() === ALL_LENSES) {
    return [...reviewLenses];
  }

  const known = new Set<string>(reviewLenses.map((lens) => lens.category));
  const requested = new Set<string>();
  for (const part of trimmed.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "") {
      continue;
    }
    if (!known.has(name)) {
      throw new Error(
        `Unknown review agent: ${name}. Valid values are ` +
          `${[...known].join(", ")}, or ${ALL_LENSES}.`,
      );
    }
    requested.add(name);
  }

  if (requested.size === 0) {
    throw new Error(
      `No review agents selected. Valid values are ${[...known].join(", ")}, ` +
        `or ${ALL_LENSES}.`,
    );
  }
  return reviewLenses.filter((lens) => requested.has(lens.category));
}

/**
 * Builds the review agents over one installation's GitHub client — the
 * set the orchestrator runs concurrently per review job. Defaults to
 * every lens; pass a narrowed list from {@link resolveReviewLenses} to
 * run a subset.
 */
export function createReviewAgents(
  deps: ReviewAgentDeps,
  lenses: readonly ReviewLens[] = reviewLenses,
): ReviewAgent[] {
  return lenses.map((lens) => createReviewAgent(lens, deps));
}
