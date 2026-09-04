/**
 * The `pnpm seed-prompts` entry point. Nothing in src/index.ts imports
 * it, so it stays out of the shipped action bundle.
 */
import {
  DEFAULT_LANGFUSE_BASE_URL,
  DEFAULT_LENS_CONFIG_PATH,
  DEFAULT_PROMPT_LABEL,
  createLangfusePromptWriter,
  inCodePrompts,
  loadLensSet,
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

import { readOptional } from "./read-optional.js";

/** Environment variables the seeder authenticates with. */
export const PUBLIC_KEY_ENV = "LANGFUSE_PUBLIC_KEY";
export const SECRET_KEY_ENV = "LANGFUSE_SECRET_KEY";
export const BASE_URL_ENV = "LANGFUSE_BASE_URL";

/** Exit code for a usage or credentials problem, before anything ran. */
export const USAGE_EXIT_CODE = 2;

/** The actionable message shown when either key is absent. */
export const MISSING_CREDENTIALS_MESSAGE = [
  `${PUBLIC_KEY_ENV} and ${SECRET_KEY_ENV} must both be set to seed prompts.`,
  "",
  "Nothing was published. Both keys are needed: seeding reads the currently",
  "labelled version before deciding whether to publish, and both calls",
  "authenticate the same way.",
  "",
  "Set them in the environment or in .env.local (gitignored) and re-run:",
  "",
  `  ${PUBLIC_KEY_ENV}=…`,
  `  ${SECRET_KEY_ENV}=…`,
  `  ${BASE_URL_ENV}=…      # optional; defaults to ${DEFAULT_LANGFUSE_BASE_URL}`,
  "",
  "  pnpm seed-prompts --dry-run",
].join("\n");

/** What one invocation was asked to do. */
export interface SeedArgs {
  label: string;
  dryRun: boolean;
  /** Lens configuration to seed prompts for. */
  config: string;
}

/** Unknown flags are a hard error: a mistyped dry-run flag must never publish. */
export function parseSeedArgs(argv: string[]): SeedArgs {
  let label = DEFAULT_PROMPT_LABEL;
  let dryRun = false;
  let config = DEFAULT_LENS_CONFIG_PATH;

  /** Reads `--flag value`, advancing past the value it consumed. */
  const takeValue = (index: number, flag: string, example: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value, for example ${flag} ${example}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      // pnpm forwards the separator verbatim.
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--label") {
      label = takeValue(index, "--label", "staging");
      index += 1;
    } else if (arg.startsWith("--label=")) {
      label = arg.slice("--label=".length);
    } else if (arg === "--config") {
      config = takeValue(index, "--config", DEFAULT_LENS_CONFIG_PATH);
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
  return { label, dryRun, config };
}

/** Reads Langfuse credentials. Keys are never logged or echoed. */
export function requireLangfuseConfig(
  env: Record<string, string | undefined>,
): LangfusePromptClientConfig {
  const publicKey = env[PUBLIC_KEY_ENV]?.trim() ?? "";
  const secretKey = env[SECRET_KEY_ENV]?.trim() ?? "";
  if (publicKey === "" || secretKey === "") {
    throw new Error(MISSING_CREDENTIALS_MESSAGE);
  }
  const baseUrl = env[BASE_URL_ENV]?.trim() ?? "";
  return {
    publicKey,
    secretKey,
    baseUrl: baseUrl === "" ? DEFAULT_LANGFUSE_BASE_URL : baseUrl,
  };
}

/** Everything the command reads from outside itself. */
export interface SeedCliEnvironment {
  env: Record<string, string | undefined>;
  createWriter: (config: LangfusePromptClientConfig) => LangfusePromptWriter;
  /** Reads the lens configuration; undefined when the file does not exist. */
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
  let lenses;
  try {
    args = parseSeedArgs(argv);
    config = requireLangfuseConfig(env);
    // Seeds exactly the prompts the configured lens set will ask for.
    lenses = await loadLensSet({
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
  write(`Lenses: ${lenses.map((lens) => lens.category).join(", ")}`);

  const report = await seedManagedPrompts(environment.createWriter(config), {
    prompts: inCodePrompts(lenses),
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
