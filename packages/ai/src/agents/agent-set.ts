/**
 * Working with a run's agent set. Every agent comes from repository
 * configuration (agents/config.ts), so both functions take the set to use.
 */
import { ALL_AGENTS, type AgentDefinition } from "./definition.js";
import { createReviewAgent, type ReviewAgentDeps } from "./runtime.js";
import type { ReviewAgent } from "../agent-contract.js";

/**
 * Narrows an agent set by name — comma-separated categories, with `all`
 * selecting every agent wherever it appears. Always in `available` order,
 * since agent order decides the order findings reach the synthesiser. An
 * unknown name throws rather than quietly running a narrower review.
 */
export function resolveAgentDefinitions(
  selection: string,
  available: readonly AgentDefinition[],
): AgentDefinition[] {
  const trimmed = selection.trim();
  if (trimmed === "") {
    return [...available];
  }

  const known = new Set<string>(available.map((agent) => agent.category));
  const choices =
    `This repository configures ${[...known].join(", ")}. ` +
    `Use one of those, or ${ALL_AGENTS}.`;
  const requested = new Set<string>();
  // Every name is checked before `all` is honoured, so a typo alongside
  // it still fails rather than hiding inside a full review.
  let selectsAll = false;
  for (const part of trimmed.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "") {
      continue;
    }
    if (name === ALL_AGENTS) {
      selectsAll = true;
      continue;
    }
    if (!known.has(name)) {
      throw new Error(`Unknown review agent: ${name}. ${choices}`);
    }
    requested.add(name);
  }

  if (selectsAll) {
    return [...available];
  }
  if (requested.size === 0) {
    throw new Error(`No review agents selected. ${choices}`);
  }
  return available.filter((agent) => requested.has(agent.category));
}

/** Builds the review agents the pipeline runs concurrently. */
export function createReviewAgents(
  deps: ReviewAgentDeps,
  agents: readonly AgentDefinition[],
): ReviewAgent[] {
  return agents.map((agent) => createReviewAgent(agent, deps));
}
