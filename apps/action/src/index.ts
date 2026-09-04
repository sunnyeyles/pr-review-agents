/**
 * The GitHub Action entrypoint. Wiring only: read action inputs, build
 * the clients, hand off to the handler.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_LANGFUSE_BASE_URL,
  DEFAULT_LENS_CONFIG_PATH,
  DEFAULT_PROMPT_LABEL,
  SYNTHESIS_PROMPT_ID,
  createAnthropicClient,
  createLangfusePromptClient,
  createReviewAgents,
  createSynthesiser,
  loadLensSet,
  loadManagedPrompts,
  resolveReviewLenses,
  type AnthropicClientConfig,
  type AnthropicLike,
  type LangfusePromptClient,
  type LangfusePromptClientConfig,
  type ManagedPrompts,
  type ReadOptionalFile,
  type ReviewLens,
} from "@pr-review/ai";
import {
  createTokenClient,
  type GithubInstallationClient,
  type GithubTokenConfig,
} from "@pr-review/github";
import {
  createConsoleLogger,
  errorMessage,
  errorName,
  type StructuredLogger,
} from "@pr-review/logging";
import {
  createCheckRunPublisher,
  runReviewPipeline,
} from "@pr-review/reviewer";

import { createActionHandler } from "./handler.js";
import {
  createLangfuseRuntime,
  type LangfuseRuntime,
  type LangfuseRuntimeConfig,
} from "./langfuse.js";
import { createFallbackPublisher } from "./summary.js";

/** Everything the entrypoint reads from outside itself; tests pass fakes. */
export interface ActionEnvironment {
  /** The process environment the action's inputs arrive in. */
  env: Record<string, string | undefined>;
  /** Reads the workflow event payload file as UTF-8 text. */
  readEventFile: (path: string) => Promise<string>;
  /** Reads a workspace file, resolving undefined when it does not exist. */
  readWorkspaceFile: ReadOptionalFile;
  createAnthropicClient: (config: AnthropicClientConfig) => AnthropicLike;
  createTokenClient: (config: GithubTokenConfig) => GithubInstallationClient;
  /** Builds the managed-prompt retrieval seam. */
  createPromptClient: (config: LangfusePromptClientConfig) => LangfusePromptClient;
  /** Starts span export for this run and returns its flush handle. */
  createLangfuseRuntime: (config: LangfuseRuntimeConfig) => LangfuseRuntime;
  logger: StructuredLogger;
  /** Marks the process as failed without exiting it. */
  setExitCode: (code: number) => void;
}

/** A missing file is the ordinary case for optional configuration. */
async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** The real environment: the live process, filesystem, and SDK clients. */
export function actionEnvironment(): ActionEnvironment {
  return {
    env: process.env,
    readEventFile: (filePath) => readFile(filePath, "utf8"),
    readWorkspaceFile: (filePath) =>
      readOptional(
        path.resolve(process.env["GITHUB_WORKSPACE"] ?? process.cwd(), filePath),
      ),
    createAnthropicClient,
    createTokenClient,
    createPromptClient: createLangfusePromptClient,
    createLangfuseRuntime,
    logger: createConsoleLogger(),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

/**
 * Reads an action input. GitHub exposes `with:` entries as INPUT_<NAME>,
 * uppercased with spaces replaced by underscores.
 */
export function getInput(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return value?.trim() ?? "";
}

export function requireInput(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = getInput(env, name);
  if (value === "") {
    throw new Error(`Missing required action input: ${name}`);
  }
  return value;
}

/** The Langfuse settings one run needs, once they are known to be usable. */
export interface LangfuseInputs {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  promptLabel: string;
}

/**
 * undefined means the review runs on in-code prompts and exports no
 * traces. Both keys are needed: the two features authenticate the same way.
 */
export function resolveLangfuseInputs(
  env: Record<string, string | undefined>,
  logger: StructuredLogger,
): LangfuseInputs | undefined {
  const publicKey = getInput(env, "langfuse-public-key");
  const secretKey = getInput(env, "langfuse-secret-key");

  if (publicKey === "" && secretKey === "") {
    return undefined;
  }
  if (publicKey === "" || secretKey === "") {
    // Half-configured: the review still runs, but prompt edits and
    // traces silently go nowhere. Never log the key that is present.
    logger.error("langfuse.disabled_incomplete_credentials", {
      missingInput:
        publicKey === "" ? "langfuse-public-key" : "langfuse-secret-key",
    });
    return undefined;
  }

  return {
    publicKey,
    secretKey,
    // The library constants are the single definition; a caller
    // invoking the bundle directly never goes through action.yml.
    baseUrl: getInput(env, "langfuse-base-url") || DEFAULT_LANGFUSE_BASE_URL,
    promptLabel: getInput(env, "langfuse-prompt-label") || DEFAULT_PROMPT_LABEL,
  };
}

/** Covers the one part loadManagedPrompts cannot: building the client. */
async function resolveManagedPrompts(
  environment: ActionEnvironment,
  inputs: LangfuseInputs,
  lenses: readonly ReviewLens[],
): Promise<ManagedPrompts | undefined> {
  try {
    const client = environment.createPromptClient({
      publicKey: inputs.publicKey,
      secretKey: inputs.secretKey,
      baseUrl: inputs.baseUrl,
    });
    const { prompts } = await loadManagedPrompts(client, {
      lenses,
      label: inputs.promptLabel,
      logger: environment.logger,
    });
    return prompts;
  } catch (error: unknown) {
    environment.logger.error("langfuse.prompts.unavailable", {
      error: errorMessage(error),
    });
    return undefined;
  }
}

/** One action run. Failures propagate to runEntrypoint's catch. */
export async function runAction(
  environment: ActionEnvironment = actionEnvironment(),
): Promise<void> {
  const { env, logger } = environment;

  const eventPath = env["GITHUB_EVENT_PATH"];
  if (eventPath === undefined || eventPath === "") {
    throw new Error(
      "GITHUB_EVENT_PATH is not set — this action must run inside a GitHub Actions workflow",
    );
  }
  const payload: unknown = JSON.parse(await environment.readEventFile(eventPath));
  const eventName = env["GITHUB_EVENT_NAME"] ?? "";

  // Resolved before any client is built, so a missing config or a typo'd
  // agent name fails the step rather than producing a review that looks
  // clean. Configuration is the only source of lenses; `agents` narrows
  // that set for one run.
  const configured = await loadLensSet({
    readFile: environment.readWorkspaceFile,
    path: getInput(env, "lens-config") || DEFAULT_LENS_CONFIG_PATH,
  });
  const lenses = resolveReviewLenses(getInput(env, "agents"), configured);
  logger.info("review.agents_selected", {
    agents: lenses.map((lens) => lens.category),
    configuredAgents: configured.map((lens) => lens.category),
  });

  const anthropic: AnthropicLike = environment.createAnthropicClient({
    apiKey: requireInput(env, "anthropic-api-key"),
  });
  const model = requireInput(env, "model");

  const langfuse = resolveLangfuseInputs(env, logger);
  // Tracing starts before the prompt fetch so the fetch's spans are captured.
  const tracing =
    langfuse === undefined
      ? undefined
      : environment.createLangfuseRuntime({
          publicKey: langfuse.publicKey,
          secretKey: langfuse.secretKey,
          baseUrl: langfuse.baseUrl,
          release: env["GITHUB_SHA"],
        });
  // Everything below may emit spans, so it sits inside the flushing block.
  try {
    const prompts =
      langfuse === undefined
        ? undefined
        : await resolveManagedPrompts(environment, langfuse, lenses);

    // Repository-independent, so one instance serves the whole run.
    const synthesiser = createSynthesiser({
      anthropic,
      model,
      lenses,
      ...(prompts === undefined
        ? {}
        : { systemPrompt: prompts[SYNTHESIS_PROMPT_ID] }),
    });
    const client = environment.createTokenClient({
      token: requireInput(env, "github-token"),
    });

    const handler = createActionHandler({
      client,
      runReviewPipeline: (reviewClient, context) =>
        runReviewPipeline(
          createReviewAgents(
            {
              anthropic,
              model,
              github: reviewClient,
              ...(prompts === undefined ? {} : { systemPrompts: prompts }),
            },
            lenses,
          ),
          synthesiser,
          context,
        ),
      // Check run first; job summary when the token cannot create one (forks).
      publishReview: createFallbackPublisher({
        publishCheckRun: createCheckRunPublisher(client),
        summaryPath: env["GITHUB_STEP_SUMMARY"],
        logger,
      }),
      logger,
    });

    await handler(payload, eventName);
  } finally {
    // A flush failure never fails a review that already ran.
    if (tracing !== undefined) {
      try {
        await tracing.forceFlush();
      } catch (error: unknown) {
        logger.error("tracing.flush_failed", {
          error: errorMessage(error),
        });
      }
    }
  }
}

/** The entrypoint guard: importing this module performs no work. */
export function runEntrypoint(
  environment: ActionEnvironment = actionEnvironment(),
): void {
  if (environment.env["GITHUB_ACTIONS"] !== "true") {
    return;
  }
  runAction(environment).catch((error: unknown) => {
    environment.logger.error("review.failed", {
      error: errorMessage(error),
      errorName: errorName(error),
    });
    environment.setExitCode(1);
  });
}

runEntrypoint();
