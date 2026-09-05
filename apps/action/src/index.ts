/**
 * The GitHub Action entrypoint. Wiring only: read action inputs, build
 * the clients, hand off to the handler.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  DEFAULT_LANGFUSE_BASE_URL,
  DEFAULT_AGENT_CONFIG_PATH,
  DEFAULT_PROMPT_LABEL,
  SYNTHESIS_PROMPT_ID,
  createLangfusePromptClient,
  createReviewAgents,
  apiKeyEnvFor,
  createModelClient,
  createSynthesiser,
  defaultModelFor,
  loadAgentDefinitions,
  loadManagedPrompts,
  resolveAgentDefinitions,
  selectsSpecificAgents,
  resolveModelProvider,
  type LangfusePromptClient,
  type LangfusePromptClientConfig,
  type ManagedPrompts,
  type ModelClient,
  type ModelClientConfig,
  type ReadOptionalFile,
  type AgentDefinition,
} from "@pr-review/ai";
import {
  createTokenClient,
  httpStatus,
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

import { inspectEvent } from "./event.js";
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
  createModelClient: (config: ModelClientConfig) => ModelClient;
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
    readEventFile: (filePath) => readFile(filePath, "utf8"),
    createModelClient,
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
  agents: readonly AgentDefinition[],
): Promise<ManagedPrompts | undefined> {
  try {
    const client = environment.createPromptClient({
      publicKey: inputs.publicKey,
      secretKey: inputs.secretKey,
      baseUrl: inputs.baseUrl,
    });
    const { prompts } = await loadManagedPrompts(client, {
      agents,
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

/** The model client for this run, and the model id to call it with. */
export interface ModelInputs {
  model: ModelClient;
  modelId: string;
}

/** Builds the run's model client. */
export function resolveModelInputs(
  env: Record<string, string | undefined>,
  environment: Pick<ActionEnvironment, "createModelClient">,
): ModelInputs {
  const provider = resolveModelProvider(getInput(env, "model-provider"));
  const keyEnv = apiKeyEnvFor(provider);
  // The provider's own variable is the fallback, so a workflow can pass each
  // provider's secret through `env` rather than picking one in YAML.
  const apiKey = getInput(env, "api-key") || (env[keyEnv] ?? "").trim();
  if (apiKey === "") {
    throw new Error(
      `Missing required action input: api-key (or the ${keyEnv} environment variable)`,
    );
  }
  const baseUrl = getInput(env, "model-base-url");
  return {
    model: environment.createModelClient({
      provider,
      apiKey,
      ...(baseUrl === "" ? {} : { baseUrl }),
    }),
    modelId: getInput(env, "model") || defaultModelFor(provider),
  };
}

/**
 * Reads repository files at one commit. The agent configuration defines
 * the agents' system prompts, so it is read at the pull request's base
 * commit rather than from the workspace: a checkout of the head or merge
 * ref would let the branch under review rewrite its own reviewers.
 */
export function readAtCommit(
  client: GithubInstallationClient,
  repository: { owner: string; repo: string },
  ref: string,
): ReadOptionalFile {
  return async (filePath) => {
    try {
      return await client.getFileContents({ ...repository, path: filePath, ref });
    } catch (error: unknown) {
      // 404 is "not configured"; anything else, a missing contents:read
      // scope included, must not read as an absent file.
      if (httpStatus(error) === 404) {
        return undefined;
      }
      throw error;
    }
  };
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

  // An event that will not be reviewed is a clean no-op: it must not fail
  // on configuration, and it has no base commit to read one from anyway.
  const inspection = inspectEvent(payload, eventName);
  if (!inspection.review) {
    logger.info("review.skipped", { reason: inspection.reason });
    return;
  }
  const { target, isFork, baseSha } = inspection;

  const client = environment.createTokenClient({
    token: requireInput(env, "github-token"),
  });

  // Resolved before the model client is built, so a missing config or a
  // typo'd agent name fails the step rather than producing a review that
  // looks clean.
  const configured = await loadAgentDefinitions({
    readFile: readAtCommit(client, target, baseSha),
    path: getInput(env, "agent-config") || DEFAULT_AGENT_CONFIG_PATH,
  });
  const selection = getInput(env, "agents");
  const agents = resolveAgentDefinitions(selection, configured);
  // Naming agents is someone asking for those agents, so their `paths`
  // no longer decide; `all` leaves the configured gating in place.
  const applyPathFilters = !selectsSpecificAgents(selection);
  logger.info("review.agents_selected", {
    agents: agents.map((agent) => agent.category),
    configuredAgents: configured.map((agent) => agent.category),
    pathFilteredAgents: agents
      .filter((agent) => agent.paths !== undefined)
      .map((agent) => agent.category),
    applyPathFilters,
  });

  const { model, modelId } = resolveModelInputs(env, environment);
  logger.info("review.model_selected", {
    provider: model.provider,
    model: modelId,
  });

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
        : await resolveManagedPrompts(environment, langfuse, agents);

    // Repository-independent, so one instance serves the whole run.
    const synthesiser = createSynthesiser({
      model,
      modelId,
      agents,
      ...(prompts === undefined
        ? {}
        : { systemPrompt: prompts[SYNTHESIS_PROMPT_ID] }),
    });
    const handler = createActionHandler({
      client,
      agents,
      applyPathFilters,
      // `activeAgents` is the subset the path gate woke, decided once the
      // changed files are known.
      runReviewPipeline: (reviewClient, context, activeAgents) =>
        runReviewPipeline(
          createReviewAgents(
            {
              model,
              modelId,
              github: reviewClient,
              ...(prompts === undefined ? {} : { systemPrompts: prompts }),
            },
            activeAgents,
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

    await handler(target, isFork);
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
