/**
 * The agent set a run works with, read from repository configuration.
 * The action ships specialists (agents/specialists/) but runs none of
 * them on its own: an entry names one, or writes a definition out in
 * full, so the agents a review runs are exactly the ones configured.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { agentDefinitionSchema, type AgentDefinition } from "./definition.js";
import { BUILT_IN_AGENT_NAMES, findBuiltInAgent } from "./specialists/index.js";

/** Where the agent configuration is read from unless a path is given. */
export const DEFAULT_AGENT_CONFIG_PATH = ".github/pr-review-agents.yml";

/** Raised for configuration that is missing, malformed, or empty. */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

// Entries are checked one at a time below rather than through a union:
// invalid_union nests each branch's issues where issueList cannot reach
// them, and a union cannot know which branch the author meant, so it
// would report the string branch's failure alongside the real problem.
const agentConfigSchema = z
  .object({
    agents: z.array(z.unknown()).min(1),
  })
  .strict();

function issueList(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** The message shown when an entry names a built-in that does not exist. */
function unknownBuiltInMessage(name: string, path: string): string {
  return [
    `${path} names an unknown built-in agent: "${name}".`,
    "",
    `The built-in agents are: ${BUILT_IN_AGENT_NAMES.join(", ")}.`,
    "Name one of those, or write the agent out in full with its own",
    "category, role, and focus.",
  ].join("\n");
}

/**
 * One `agents:` entry: the name of a built-in specialist, or a definition
 * written out in full. Errors carry the entry's position, since a list
 * offers nothing else to point at.
 */
function resolveAgentEntry(
  entry: unknown,
  index: number,
  path: string,
): AgentDefinition {
  if (typeof entry === "string") {
    const name = entry.trim();
    const builtIn = findBuiltInAgent(name);
    if (builtIn === undefined) {
      throw new AgentConfigError(unknownBuiltInMessage(name, path));
    }
    return builtIn;
  }

  const parsed = agentDefinitionSchema.safeParse(entry);
  if (!parsed.success) {
    throw new AgentConfigError(
      `${path} agents[${index}] is invalid — ${issueList(parsed.error)}`,
    );
  }
  return parsed.data;
}

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
    throw new AgentConfigError(`${path} is invalid — ${issueList(parsed.error)}`);
  }

  const agents = parsed.data.agents.map((entry, index) =>
    resolveAgentEntry(entry, index, path),
  );

  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.category)) {
      throw new AgentConfigError(
        `${path} defines the review agent "${agent.category}" twice`,
      );
    }
    seen.add(agent.category);
  }
  return agents;
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
    "This action runs no agents of its own — it reviews with exactly the",
    "ones you name. Create the file with at least one built-in specialist:",
    "",
    "  agents:",
    ...BUILT_IN_AGENT_NAMES.map((name) => `    - ${name}`),
    "",
    "Or write an agent of your own out in full:",
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
    "The action reads this from the pull request's base commit, so commit it",
    "to your default branch. See the README for a fuller starting point.",
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
