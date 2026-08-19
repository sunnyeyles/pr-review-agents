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
  createAnthropicClient,
  createReviewAgents,
  type AnthropicClientConfig,
  type AnthropicLike,
} from "@pr-review/ai";
import {
  createTokenClient,
  type GithubInstallationClient,
  type GithubTokenConfig,
} from "@pr-review/github";
import { createConsoleLogger, type StructuredLogger } from "@pr-review/logging";
import {
  createCheckRunPublisher,
  createSynthesiser,
  runReviewPipeline,
} from "@pr-review/reviewer";

import { createActionHandler } from "./handler.js";
import { createFallbackPublisher } from "./summary.js";

export { createActionHandler, type ActionHandler, type ActionHandlerDeps, type ActionResult } from "./handler.js";
export { inspectEvent, type EventInspection } from "./event.js";
export {
  appendJobSummary,
  createFallbackPublisher,
  httpStatus,
  isPermissionError,
  renderJobSummary,
  type FallbackPublisherDeps,
} from "./summary.js";

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
  // The Synthesiser (spec §16) shares the agents' client and model:
  // §16 defines no separate model configuration. It is
  // repository-independent (no GitHub tools), so one instance serves
  // the single review this process performs.
  const synthesiser = createSynthesiser({ anthropic, model });
  const client = environment.createTokenClient({
    token: requireInput(env, "github-token"),
  });

  const handler = createActionHandler({
    client,
    runReviewPipeline: (reviewClient, context) =>
      runReviewPipeline(
        createReviewAgents({ anthropic, model, github: reviewClient }),
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
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "Error",
    });
    environment.setExitCode(1);
  });
}

runEntrypoint();
