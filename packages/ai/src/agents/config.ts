/**
 * The agent set a run works with, read from repository configuration.
 * There is no built-in set: the agents a review runs are exactly the
 * ones configured, so nothing in the system may assume which agents, or
 * how many, exist.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { agentDefinitionSchema, type AgentDefinition } from "./definition.js";

/** Where the agent configuration is read from unless a path is given. */
export const DEFAULT_AGENT_CONFIG_PATH = ".github/pr-review-agents.yml";

/** Raised for configuration that is missing, malformed, or empty. */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

const agentConfigSchema = z
  .object({
    agents: z.array(agentDefinitionSchema).min(1),
  })
  .strict();

/** Parses and validates a config document into the agents it defines. */
export function parseAgentConfig(source: string, path: string): AgentDefinition[] {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error: unknown) {
    throw new AgentConfigError(
      `${path} is not valid YAML: ${(error as Error).message}`,
    );
  }

  const parsed = agentConfigSchema.safeParse(document ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AgentConfigError(`${path} is invalid — ${problems}`);
  }

  const seen = new Set<string>();
  for (const agent of parsed.data.agents) {
    if (seen.has(agent.category)) {
      throw new AgentConfigError(
        `${path} defines the review agent "${agent.category}" twice`,
      );
    }
    seen.add(agent.category);
  }
  return parsed.data.agents;
}

/** Reads a file, or resolves undefined when it does not exist. */
export type ReadOptionalFile = (path: string) => Promise<string | undefined>;

export interface LoadAgentDefinitionsOptions {
  readFile: ReadOptionalFile;
  /** Defaults to DEFAULT_AGENT_CONFIG_PATH. */
  path?: string | undefined;
}

/** The message shown when no configuration is found. */
function missingConfigMessage(path: string): string {
  return [
    `No review agents are configured: ${path} does not exist.`,
    "",
    "This action ships no agents of its own — it reviews with exactly the",
    "ones you define. Create the file with at least one agent:",
    "",
    "  agents:",
    "    - category: correctness",
    "      role: Correctness reviewer",
    "      focus: |",
    "        Review the pull request ONLY for correctness problems:",
    "        - bugs and incorrect logic",
    "        - missing validation",
    "        Do NOT report style or architectural opinions.",
    "",
    "The action reads this from the checked-out workspace, so the job needs",
    "an actions/checkout step. See the README for a fuller starting point.",
  ].join("\n");
}

/**
 * The agent set for one run. A missing or unusable config fails loudly:
 * a review that ran the wrong agents — or none — looks exactly like a
 * clean bill of health.
 */
export async function loadAgentDefinitions(
  options: LoadAgentDefinitionsOptions,
): Promise<AgentDefinition[]> {
  const path = options.path ?? DEFAULT_AGENT_CONFIG_PATH;

  const source = await options.readFile(path);
  if (source === undefined) {
    throw new AgentConfigError(missingConfigMessage(path));
  }
  return parseAgentConfig(source, path);
}
