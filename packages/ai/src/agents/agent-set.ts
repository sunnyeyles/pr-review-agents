/**
 * Working with a run's agent set. Every agent comes from repository
 * configuration (agents/config.ts), so both functions take the set to use.
 */
import { ALL_AGENTS, type AgentDefinition } from "./definition.js";
import { compilePathFilter } from "./path-filter.js";
import { createReviewAgent, type ReviewAgentDeps } from "./runtime.js";
import type { ReviewAgent } from "../agent-contract.js";

/**
 * Narrows an agent set by name — comma-separated categories, with `all`
 * selecting every agent wherever it appears. Always in `available` order,
 * since agent order decides the order findings reach the synthesiser. An
 * unknown name throws rather than quietly running a narrower review.
 *
 * A named agent comes back without its `paths`: asking for an agent by
 * name is asking for it, so its gate no longer decides.
 */
export function resolveAgentDefinitions(
  selection: string,
  available: readonly AgentDefinition[],
): AgentDefinition[] {
  if (selection.trim() === "") {
    return [...available];
  }
  const names = selection
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((name) => name !== "");

  const known = new Set<string>(available.map((agent) => agent.category));
  const choices =
    `This repository configures ${[...known].join(", ")}. ` +
    `Use one of those, or ${ALL_AGENTS}.`;
  const requested = new Set<string>();
  // Every name is checked before `all` is honoured, so a typo alongside
  // it still fails rather than hiding inside a full review.
  let selectsAll = false;
  for (const name of names) {
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
  return available
    .filter((agent) => requested.has(agent.category))
    .map(({ paths: _gate, ...agent }) => agent);
}

/** One agent that did not run, and the patterns nothing matched. */
export interface SkippedAgent {
  agent: string;
  paths: readonly string[];
}

export interface GatedAgents {
  active: AgentDefinition[];
  skipped: SkippedAgent[];
}

/**
 * Splits an agent set by whether the pull request touched the paths each
 * agent declared. A gate, not a narrowing: an agent it wakes still
 * reviews the whole pull request. An agent declaring no paths always
 * runs, so a configuration without them behaves exactly as before.
 */
export function gateAgentsByPaths(
  agents: readonly AgentDefinition[],
  changedFiles: readonly string[],
): GatedAgents {
  const active: AgentDefinition[] = [];
  const skipped: SkippedAgent[] = [];
  for (const agent of agents) {
    const paths = agent.paths;
    if (paths === undefined) {
      active.push(agent);
      continue;
    }
    if (changedFiles.some(compilePathFilter(paths))) {
      active.push(agent);
    } else {
      skipped.push({ agent: agent.category, paths });
    }
  }
  return { active, skipped };
}

/** Builds the review agents the pipeline runs concurrently. */
export function createReviewAgents(
  deps: ReviewAgentDeps,
  agents: readonly AgentDefinition[],
): ReviewAgent[] {
  return agents.map((agent) => createReviewAgent(agent, deps));
}
