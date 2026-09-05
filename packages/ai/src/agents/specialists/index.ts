/**
 * The specialists this action ships. None of them run on their own: a
 * repository opts in by naming one in its agent configuration, so a run
 * still carries exactly the agents it was configured with.
 */
import type { AgentDefinition } from "../definition.js";
import { DOCS_DRIFT_AGENT } from "./docs-drift-agent.js";
import { SECURITY_AGENT } from "./security-agent.js";

/** Listing order is what an error message offers; it is not a run order. */
export const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
  SECURITY_AGENT,
  DOCS_DRIFT_AGENT,
];

/** The names configuration may use, for error messages and documentation. */
export const BUILT_IN_AGENT_NAMES: readonly string[] = BUILT_IN_AGENTS.map(
  (agent) => agent.category,
);

export function findBuiltInAgent(name: string): AgentDefinition | undefined {
  return BUILT_IN_AGENTS.find((agent) => agent.category === name);
}
