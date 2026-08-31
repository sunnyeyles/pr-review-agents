/**
 * The three review lenses. Each differs only in its focus and, for
 * Architecture, extra context guidance; the rest lives in agent-runtime.ts.
 */
import {
  createReviewAgent,
  type ReviewAgentDeps,
  type ReviewLens,
} from "./runtime.js";
import type { ReviewAgent } from "../review-types.js";

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
 * Resolves the `agents` input — comma-separated lens categories, with
 * `all` selecting every lens wherever it appears. Always in
 * `reviewLenses` order, since agent order decides the order findings
 * reach the synthesiser. An unknown name throws.
 */
export function resolveReviewLenses(selection: string): ReviewLens[] {
  const trimmed = selection.trim();
  if (trimmed === "") {
    return [...reviewLenses];
  }

  const known = new Set<string>(reviewLenses.map((lens) => lens.category));
  const requested = new Set<string>();
  // Every name is checked before `all` is honoured, so a typo alongside
  // it still fails rather than hiding inside a full review.
  let selectsAll = false;
  for (const part of trimmed.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "") {
      continue;
    }
    if (name === ALL_LENSES) {
      selectsAll = true;
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

  if (selectsAll) {
    return [...reviewLenses];
  }
  if (requested.size === 0) {
    throw new Error(
      `No review agents selected. Valid values are ${[...known].join(", ")}, ` +
        `or ${ALL_LENSES}.`,
    );
  }
  return reviewLenses.filter((lens) => requested.has(lens.category));
}

/** Builds the review agents the pipeline runs concurrently; defaults to every lens. */
export function createReviewAgents(
  deps: ReviewAgentDeps,
  lenses: readonly ReviewLens[] = reviewLenses,
): ReviewAgent[] {
  return lenses.map((lens) => createReviewAgent(lens, deps));
}
