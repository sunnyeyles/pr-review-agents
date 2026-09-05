/**
 * The `pnpm seed-prompts` entry point. Nothing in src/index.ts imports
 * it, so it stays out of the shipped action bundle.
 */
import {
  DEFAULT_AGENT_CONFIG_PATH,
  DEFAULT_PROMPT_LABEL,
  createLangfusePromptWriter,
  inCodePrompts,
  loadAgentDefinitions,
  seedFailed,
  seedManagedPrompts,
  type LangfusePromptClientConfig,
  type LangfusePromptWriter,
  type ReadOptionalFile,
} from "@pr-review/ai";
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import {
  USAGE_EXIT_CODE,
  missingCredentialsMessage,
  requireLangfuseConfig,
  takeValue,
} from "./cli-env.js";
import { readOptional } from "./read-optional.js";

export { USAGE_EXIT_CODE };

/** The actionable message shown when either key is absent. */
export const MISSING_CREDENTIALS_MESSAGE = missingCredentialsMessage({
  purpose: "seed prompts",
  rationale: [
    "Nothing was published. Both keys are needed: seeding reads the currently",
    "labelled version before deciding whether to publish, and both calls",
    "authenticate the same way.",
  ],
  command: "pnpm seed-prompts --dry-run",
});

/** What one invocation was asked to do. */
export interface SeedArgs {
  label: string;
  dryRun: boolean;
  /** Agent configuration to seed prompts for. */
  config: string;
}

/** Unknown flags are a hard error: a mistyped dry-run flag must never publish. */
export function parseSeedArgs(argv: string[]): SeedArgs {
  let label = DEFAULT_PROMPT_LABEL;
  let dryRun = false;
  let config = DEFAULT_AGENT_CONFIG_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      // pnpm forwards the separator verbatim.
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--label") {
      label = takeValue(argv, index, "--label", "staging");
      index += 1;
    } else if (arg.startsWith("--label=")) {
      label = arg.slice("--label=".length);
    } else if (arg === "--config") {
      config = takeValue(argv, index, "--config", DEFAULT_AGENT_CONFIG_PATH);
      index += 1;
    } else if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (label.trim() === "") {
    throw new Error("--label needs a value, for example --label staging");
  }
  if (config.trim() === "") {
    throw new Error(
      `--config needs a value, for example --config ${DEFAULT_AGENT_CONFIG_PATH}`,
    );
  }
  return { label, dryRun, config };
}

/** Reads Langfuse credentials. Keys are never logged or echoed. */
/** Everything the command reads from outside itself. */
export interface SeedCliEnvironment {
  env: Record<string, string | undefined>;
  createWriter: (config: LangfusePromptClientConfig) => LangfusePromptWriter;
  /** Reads the agent configuration; undefined when the file does not exist. */
  readConfigFile: ReadOptionalFile;
  logger: StructuredLogger;
  /** Where the human-readable summary goes. */
  write: (line: string) => void;
}

/** The real environment: the live process and the Langfuse SDK. */
export function seedCliEnvironment(): SeedCliEnvironment {
  return {
    env: process.env,
    createWriter: createLangfusePromptWriter,
    readConfigFile: readOptional,
    logger: createConsoleLogger(),
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}

/** Returns the exit code rather than exiting; the runner script owns process control. */
export async function main(
  argv: string[],
  environment: SeedCliEnvironment = seedCliEnvironment(),
): Promise<number> {
  const { env, logger, write } = environment;

  let args: SeedArgs;
  let config: LangfusePromptClientConfig;
  let agents;
  try {
    args = parseSeedArgs(argv);
    config = requireLangfuseConfig(env, MISSING_CREDENTIALS_MESSAGE);
    // Seeds exactly the prompts the configured agent set will ask for.
    agents = await loadAgentDefinitions({
      readFile: environment.readConfigFile,
      path: args.config,
    });
  } catch (error: unknown) {
    write(errorMessage(error));
    return USAGE_EXIT_CODE;
  }

  write(
    `Seeding ${config.baseUrl} at label "${args.label}"${
      args.dryRun ? " (dry run — nothing will be written)" : ""
    }`,
  );
  write(`Agents: ${agents.map((agent) => agent.category).join(", ")}`);

  const report = await seedManagedPrompts(environment.createWriter(config), {
    prompts: inCodePrompts(agents),
    label: args.label,
    dryRun: args.dryRun,
    logger,
  });

  const idWidth = Math.max(
    13,
    ...Object.keys(report).map((id) => id.length + 1),
  );
  for (const [id, outcome] of Object.entries(report)) {
    write(
      `  ${id.padEnd(idWidth)} ${args.dryRun ? `would be ${outcome}` : outcome}`,
    );
  }

  if (seedFailed(report)) {
    write("");
    write(
      "Some prompts were not published. A rejected prompt failed the contract",
    );
    write("guard; a failed one could not be read from or written to Langfuse.");
    return 1;
  }
  return 0;
}
