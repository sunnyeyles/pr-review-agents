/**
 * @pr-review/action
 *
 * GitHub Action entrypoint: runs the review inside the customer's own
 * workflow. The three agents, the Synthesiser, and the deterministic
 * validation chain all live in shared code (@pr-review/reviewer); this
 * app only adapts the Actions environment to it.
 *
 * What the runner provides, so this app does not: the retry semantics
 * (a workflow run, re-runnable from the Actions UI), the compute, and
 * the credentials. Nothing is fetched from a secrets store — the
 * Anthropic key arrives as an action input backed by a repository
 * secret, and the GitHub token is the one GitHub already handed the
 * workflow.
 *
 * Failure semantics: a review that fails outright (every agent
 * produced invalid output) fails the step, so the run can be retried.
 * An event that is not a reviewable pull request is a clean no-op.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  DEFAULT_LANGFUSE_BASE_URL,
  DEFAULT_PROMPT_LABEL,
  createAnthropicClient,
  createLangfusePromptClient,
  createReviewAgents,
  loadManagedPrompts,
  type AnthropicClientConfig,
  type AnthropicLike,
  type LangfusePromptClient,
  type LangfusePromptClientConfig,
  type ManagedPrompts,
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
  SYNTHESIS_SYSTEM_PROMPT,
  createCheckRunPublisher,
  createSynthesiser,
  runReviewPipeline,
} from "@pr-review/reviewer";

import { createActionHandler } from "./handler.js";
import {
  createLangfuseRuntime,
  type LangfuseRuntime,
  type LangfuseRuntimeConfig,
} from "./langfuse.js";
import { createFallbackPublisher } from "./summary.js";

/**
 * Everything the entrypoint reads from outside itself: the process
 * environment, the event file, the two client factories, the logger,
 * and the way a failed run marks the process. Production passes
 * {@link actionEnvironment}; tests pass fakes, so the entrypoint can be
 * exercised without a runner, a filesystem, or a model.
 */
export interface ActionEnvironment {
  /** The process environment the action's inputs arrive in. */
  env: Record<string, string | undefined>;
  /** Reads the workflow event payload file as UTF-8 text. */
  readEventFile: (path: string) => Promise<string>;
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

/** The real environment: the live process, filesystem, and SDK clients. */
export function actionEnvironment(): ActionEnvironment {
  return {
    env: process.env,
    readEventFile: (path) => readFile(path, "utf8"),
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
 * Reads an action input. GitHub exposes `with:` entries as
 * INPUT_<NAME> with the name uppercased and spaces replaced by
 * underscores (dashes are preserved) — the same rule @actions/core
 * implements, reproduced here so the bundle stays dependency-free.
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
 * Decides whether this run uses Langfuse at all, from the action
 * inputs. Returning undefined means the review runs on its in-code
 * prompts and exports no traces — the default, and the only behaviour
 * available before these inputs existed.
 *
 * Both keys are needed for either feature: prompt fetching and span
 * export authenticate the same way.
 */
export function resolveLangfuseInputs(
  env: Record<string, string | undefined>,
  logger: StructuredLogger,
): LangfuseInputs | undefined {
  const publicKey = getInput(env, "langfuse-public-key");
  const secretKey = getInput(env, "langfuse-secret-key");

  if (publicKey === "" && secretKey === "") {
    // The default. Saying so on every run would be noise.
    return undefined;
  }
  if (publicKey === "" || secretKey === "") {
    // Half-configured is a mistake worth naming: the review still runs,
    // but prompt edits and traces silently go nowhere, which is hard to
    // diagnose from the outside. Report which side is missing, never
    // the value of the side that is present.
    logger.error("langfuse.disabled_incomplete_credentials", {
      missingInput:
        publicKey === "" ? "langfuse-public-key" : "langfuse-secret-key",
    });
    return undefined;
  }

  return {
    publicKey,
    secretKey,
    // action.yml defaults both, but a caller invoking the bundle
    // directly does not go through it, so the library constants are
    // the single definition and action.yml only documents them.
    baseUrl: getInput(env, "langfuse-base-url") || DEFAULT_LANGFUSE_BASE_URL,
    promptLabel: getInput(env, "langfuse-prompt-label") || DEFAULT_PROMPT_LABEL,
  };
}

/**
 * Resolves the managed system prompts, absorbing every failure.
 *
 * loadManagedPrompts already falls back per prompt and never rejects;
 * this wrapper covers the one part that still can — building the
 * client — so a Langfuse problem can never fail a review.
 */
async function resolveManagedPrompts(
  environment: ActionEnvironment,
  inputs: LangfuseInputs,
): Promise<ManagedPrompts | undefined> {
  try {
    const client = environment.createPromptClient({
      publicKey: inputs.publicKey,
      secretKey: inputs.secretKey,
      baseUrl: inputs.baseUrl,
    });
    const { prompts } = await loadManagedPrompts(client, {
      synthesisFallback: SYNTHESIS_SYSTEM_PROMPT,
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

/**
 * One action run: read the event, build the clients, hand the payload
 * to the handler. Every failure propagates to the caller, which is the
 * entrypoint's catch — the single place a failed review is reported.
 */
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

  const anthropic: AnthropicLike = environment.createAnthropicClient({
    apiKey: requireInput(env, "anthropic-api-key"),
  });
  const model = requireInput(env, "model");

  const langfuse = resolveLangfuseInputs(env, logger);
  // Tracing starts before the prompt fetch so the fetch's own spans are
  // captured, and the prompts are resolved before anything that
  // consumes them is built.
  const tracing =
    langfuse === undefined
      ? undefined
      : environment.createLangfuseRuntime({
          // No `environment`: Langfuse treats it as a slug naming a
          // deployment stage, and the obvious candidate here
          // (GITHUB_REPOSITORY) is a slash-separated path, not a stage.
          // The commit is a genuine release identifier, so it maps.
          publicKey: langfuse.publicKey,
          secretKey: langfuse.secretKey,
          baseUrl: langfuse.baseUrl,
          release: env["GITHUB_SHA"],
        });
  // Everything below may emit spans, so it all sits inside the
  // block whose finally flushes them.
  try {
    const prompts =
      langfuse === undefined
        ? undefined
        : await resolveManagedPrompts(environment, langfuse);

    // The Synthesiser (spec §16) shares the agents' client and model:
    // §16 defines no separate model configuration. It is
    // repository-independent (no GitHub tools), so one instance serves
    // the single review this process performs.
    const synthesiser = createSynthesiser({
      anthropic,
      model,
      ...(prompts === undefined ? {} : { systemPrompt: prompts.synthesis }),
    });
    const client = environment.createTokenClient({
      token: requireInput(env, "github-token"),
    });

    const handler = createActionHandler({
      client,
      runReviewPipeline: (reviewClient, context) =>
        runReviewPipeline(
          createReviewAgents({
            anthropic,
            model,
            github: reviewClient,
            ...(prompts === undefined
              ? {}
              : {
                  systemPrompts: {
                    correctness: prompts.correctness,
                    security: prompts.security,
                    architecture: prompts.architecture,
                  },
                }),
          }),
          synthesiser,
          context,
        ),
      // Check run first; job summary when the workflow token cannot
      // create one (fork pull requests).
      publishReview: createFallbackPublisher({
        publishCheckRun: createCheckRunPublisher(client),
        summaryPath: env["GITHUB_STEP_SUMMARY"],
        logger,
      }),
      logger,
    });

    await handler(payload, eventName);
  } finally {
    // A flush failure is worth knowing about but never worth failing a
    // review that already ran.
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

/**
 * The entrypoint guard and its top-level catch. Only runs as the action
 * entrypoint; importing this module (tests, bundle smoke checks)
 * performs no work and needs no configuration.
 */
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
