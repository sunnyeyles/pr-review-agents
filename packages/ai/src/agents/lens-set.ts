/**
 * Working with a run's lens set. There is no built-in set and no default:
 * every lens comes from repository configuration (lens-config.ts), so
 * both functions here take the set they are to work with.
 */
import { ALL_LENSES, type ReviewLens } from "./lens.js";
import { createReviewAgent, type ReviewAgentDeps } from "./runtime.js";
import type { ReviewAgent } from "../review-types.js";

/**
 * Narrows a lens set by name — comma-separated categories, with `all`
 * selecting every lens wherever it appears. Always in `available` order,
 * since lens order decides the order findings reach the synthesiser. An
 * unknown name throws rather than quietly running a narrower review.
 */
export function resolveReviewLenses(
  selection: string,
  available: readonly ReviewLens[],
): ReviewLens[] {
  const trimmed = selection.trim();
  if (trimmed === "") {
    return [...available];
  }

  const known = new Set<string>(available.map((lens) => lens.category));
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
        `Unknown review agent: ${name}. This repository configures ` +
          `${[...known].join(", ")}. Use one of those, or ${ALL_LENSES}.`,
      );
    }
    requested.add(name);
  }

  if (selectsAll) {
    return [...available];
  }
  if (requested.size === 0) {
    throw new Error(
      `No review agents selected. This repository configures ` +
        `${[...known].join(", ")}. Use one of those, or ${ALL_LENSES}.`,
    );
  }
  return available.filter((lens) => requested.has(lens.category));
}

/** Builds the review agents the pipeline runs concurrently. */
export function createReviewAgents(
  deps: ReviewAgentDeps,
  lenses: readonly ReviewLens[],
): ReviewAgent[] {
  return lenses.map((lens) => createReviewAgent(lens, deps));
}
