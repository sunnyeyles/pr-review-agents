/**
 * The `pnpm collect-feedback` entry point. Nothing in src/index.ts
 * imports it, so it stays out of the shipped action bundle.
 */
import {
  createLangfuseScoreSink,
  type FeedbackScoreSink,
  type LangfusePromptClientConfig,
} from "@pr-review/ai";
import {
  createTokenFeedbackClient,
  type FeedbackClientConfig,
  type GithubFeedbackClient,
} from "@pr-review/github";
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";
import { collectFeedback, type CollectFeedbackReport } from "@pr-review/reviewer";

import {
  USAGE_EXIT_CODE,
  missingCredentialsMessage,
  requireLangfuseConfig,
  takeValue,
} from "./cli-env.js";

/** The actionable message shown when either key is absent. */
export const MISSING_CREDENTIALS_MESSAGE = missingCredentialsMessage({
  purpose: "record feedback scores",
  rationale: [
    "Nothing was recorded. Both keys are needed: scores are written against",
    "the review run that produced each finding, and every call authenticates",
    "the same way.",
  ],
  command: "pnpm collect-feedback --dry-run",
});

export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
export const GITHUB_REPOSITORY_ENV = "GITHUB_REPOSITORY";

/** How far back the collector looks when not told. */
export const DEFAULT_SINCE_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CollectArgs {
  /** owner/name; undefined means read GITHUB_REPOSITORY. */
  repository: string | undefined;
  sinceDays: number;
  dryRun: boolean;
}

/** Unknown flags are a hard error: a mistyped dry-run flag must never write. */
export function parseCollectArgs(argv: string[]): CollectArgs {
  let repository: string | undefined;
  let sinceDays = DEFAULT_SINCE_DAYS;
  let dryRun = false;

  const parseDays = (value: string): number => {
    const days = Number(value);
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error(`--since-days needs a positive whole number, got "${value}"`);
    }
    return days;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--repo") {
      repository = takeValue(argv, index, "--repo", "octo-org/example");
      index += 1;
    } else if (arg.startsWith("--repo=")) {
      repository = arg.slice("--repo=".length);
    } else if (arg === "--since-days") {
      sinceDays = parseDays(takeValue(argv, index, "--since-days", "14"));
      index += 1;
    } else if (arg.startsWith("--since-days=")) {
      sinceDays = parseDays(arg.slice("--since-days=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { repository, sinceDays, dryRun };
}

/** "owner/name" split in two; anything else is a usage error. */
export function parseRepository(value: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(
      `Repository must be owner/name, got "${value}". Pass --repo or set ${GITHUB_REPOSITORY_ENV}.`,
    );
  }
  return { owner: match[1], repo: match[2] };
}

export interface CollectCliEnvironment {
  env: Record<string, string | undefined>;
  createGithub: (config: FeedbackClientConfig) => GithubFeedbackClient;
  createSink: (config: LangfusePromptClientConfig) => FeedbackScoreSink;
  now: () => Date;
  logger: StructuredLogger;
  write: (line: string) => void;
}

export function collectCliEnvironment(): CollectCliEnvironment {
  return {
    env: process.env,
    createGithub: createTokenFeedbackClient,
    createSink: createLangfuseScoreSink,
    now: () => new Date(),
    logger: createConsoleLogger(),
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}

function describe(report: CollectFeedbackReport, dryRun: boolean): string[] {
  const rows: [string, number][] = [
    ["pull requests visited", report.pullRequestsVisited],
    ["review comments scanned", report.commentsScanned],
    ["thumbs reactions found", report.reactionsFound],
    [`scores ${dryRun ? "that would land" : "recorded"}`, report.scoresRecorded],
    ["skipped: untraced run", report.skippedUntraced],
    ["skipped: no write access", report.skippedNoWriteAccess],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}   ${value}`);
}

/** Returns the exit code rather than exiting; the runner script owns process control. */
export async function main(
  argv: string[],
  environment: CollectCliEnvironment = collectCliEnvironment(),
): Promise<number> {
  const { env, logger, write } = environment;

  let args: CollectArgs;
  let langfuse: LangfusePromptClientConfig;
  let repository: { owner: string; repo: string };
  let token: string;
  try {
    args = parseCollectArgs(argv);
    langfuse = requireLangfuseConfig(env, MISSING_CREDENTIALS_MESSAGE);
    repository = parseRepository(
      args.repository ?? env[GITHUB_REPOSITORY_ENV] ?? "",
    );
    token = env[GITHUB_TOKEN_ENV]?.trim() ?? "";
    if (token === "") {
      throw new Error(
        `${GITHUB_TOKEN_ENV} must be set: reading reactions and collaborator permissions needs a token.`,
      );
    }
  } catch (error: unknown) {
    write(errorMessage(error));
    return USAGE_EXIT_CODE;
  }

  const since = new Date(environment.now().getTime() - args.sinceDays * MS_PER_DAY);
  write(
    `Collecting thumbs on ${repository.owner}/${repository.repo} pull requests updated since ${since.toISOString()}${
      args.dryRun ? " (dry run — nothing will be written)" : ""
    }`,
  );

  const report = await collectFeedback(
    environment.createGithub({ token }),
    environment.createSink(langfuse),
    { repository, since, dryRun: args.dryRun, logger },
  );
  for (const line of describe(report, args.dryRun)) {
    write(line);
  }
  return 0;
}
