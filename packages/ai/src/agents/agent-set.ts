/**
 * Working with a run's agent set. Every agent comes from repository
 * configuration (agents/config.ts), so both functions take the set to use.
 */
import { ALL_AGENTS, type AgentDefinition } from "./definition.js";
import { compilePathFilter } from "./path-filter.js";
import { createReviewAgent, type ReviewAgentDeps } from "./runtime.js";
import type { ReviewAgent } from "../agent-contract.js";

/** The non-empty, normalised names in a comma-separated selection. */
function selectionNames(selection: string): string[] {
  return selection
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((name) => name !== "");
}

/**
 * True when the selection named agents rather than taking `all`. Such a
 * run is someone asking for those agents specifically, so path filters
 * do not then decide the answer for them.
 */
export function selectsSpecificAgents(selection: string): boolean {
  const names = selectionNames(selection);
  return names.length > 0 && !names.includes(ALL_AGENTS);
}

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
  if (selection.trim() === "") {
    return [...available];
  }
  const names = selectionNames(selection);

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
  return available.filter((agent) => requested.has(agent.category));
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
    const filter = compilePathFilter(paths);
    if (changedFiles.some((file) => filter.matches(file))) {
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
