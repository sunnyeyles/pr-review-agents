/**
 * The agent set a run works with, read from repository configuration.
 * Configuration names shipped specialists; it cannot define new ones.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AgentDefinition } from "./definition.js";
import { agentPathsSchema } from "./path-filter.js";
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

/** The built-ins, listed the way configuration spells them. */
function builtInList(): string[] {
  return BUILT_IN_AGENT_NAMES.map((name) => `    - ${name}`);
}

/** The message shown when an entry names a built-in that does not exist. */
function unknownBuiltInMessage(name: string, path: string): string {
  return [
    `${path} names an unknown built-in agent: "${name}".`,
    "",
    `The built-in agents are: ${BUILT_IN_AGENT_NAMES.join(", ")}.`,
  ].join("\n");
}

/** A built-in named for its overrides; `agent` is what distinguishes it. */
const builtInEntrySchema = z
  .object({
    agent: z.string().min(1),
    model: z.string().trim().min(1).optional(),
    paths: agentPathsSchema.optional(),
  })
  .strict();

/** True for the `agent:` form, so its errors never read as a bad name. */
function namesBuiltIn(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && "agent" in entry;
}

/** The message shown for an entry that is neither spelling of a name. */
function notANameMessage(index: number, path: string): string {
  return [
    `${path} agents[${index}] does not name a built-in agent.`,
    "",
    "An entry is a built-in's name, on its own or under `agent:` with",
    "`model` or `paths` beside it. Agents are not defined in this file.",
    "",
    "  agents:",
    ...builtInList(),
    "",
    `The built-in agents are: ${BUILT_IN_AGENT_NAMES.join(", ")}.`,
  ].join("\n");
}

/**
 * One `agents:` entry: a specialist's name, alone or with `model` and `paths`.
 * Errors carry the entry's position.
 */
function resolveAgentEntry(
  entry: unknown,
  index: number,
  path: string,
): AgentDefinition {
  // A bare name is the `agent:` form without the overrides, so both
  // spellings resolve down one branch.
  if (typeof entry !== "string" && !namesBuiltIn(entry)) {
    throw new AgentConfigError(notANameMessage(index, path));
  }

  const named = builtInEntrySchema.safeParse(
    typeof entry === "string" ? { agent: entry } : entry,
  );
  if (!named.success) {
    throw new AgentConfigError(
      `${path} agents[${index}] is invalid — ${issueList(named.error)}`,
    );
  }
  const name = named.data.agent.trim();
  const builtIn = findBuiltInAgent(name);
  if (builtIn === undefined) {
    throw new AgentConfigError(unknownBuiltInMessage(name, path));
  }
  return {
    ...builtIn,
    ...(named.data.model === undefined ? {} : { model: named.data.model }),
    ...(named.data.paths === undefined ? {} : { paths: named.data.paths }),
  };
}

/** Parses and validates a config document into the agents it names. */
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
        `${path} names the review agent "${agent.category}" twice`,
      );
    }
    seen.add(agent.category);
  }
  return agents;
}

/** Reads a file, or resolves undefined when it does not exist. */
export type ReadOptionalFile = (path: string) => Promise<string | undefined>;

interface LoadAgentDefinitionsOptions {
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
    ...builtInList(),
    "",
    "The action reads this from the pull request's base commit, so commit it",
    "to your default branch. See the README for a fuller starting point.",
  ].join("\n");
}

/**
 * The agent set for one run. A missing or unusable config throws: a review
 * that ran no agents looks exactly like a clean bill of health.
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
