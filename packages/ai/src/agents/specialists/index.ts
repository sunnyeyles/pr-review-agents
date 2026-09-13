/**
 * The specialists this action ships. None run unless a repository names one in
 * its agent configuration.
 */
import type { AgentDefinition } from "../definition.js";
import { CORRECTNESS_AGENT } from "./correctness-agent.js";
import { DOCS_DRIFT_AGENT } from "./docs-drift-agent.js";
import { PERFORMANCE_AGENT } from "./performance-agent.js";
import { SECURITY_AGENT } from "./security-agent.js";
import { TEST_COVERAGE_AGENT } from "./test-coverage-agent.js";

/** Listing order is what an error message offers; it is not a run order. */
const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
  SECURITY_AGENT,
  CORRECTNESS_AGENT,
  PERFORMANCE_AGENT,
  TEST_COVERAGE_AGENT,
  DOCS_DRIFT_AGENT,
];

/** The names configuration may use, for error messages and documentation. */
export const BUILT_IN_AGENT_NAMES: readonly string[] = BUILT_IN_AGENTS.map(
  (agent) => agent.category,
);

export function findBuiltInAgent(name: string): AgentDefinition | undefined {
  return BUILT_IN_AGENTS.find((agent) => agent.category === name);
}
