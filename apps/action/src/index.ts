/**
 * @pr-review/action
 *
 * GitHub Action entrypoint: runs the review inside the customer's own
 * workflow. Same three agents, same Synthesiser, same deterministic
 * validation chain as the worker Lambda — the review pipeline is
 * shared code (@pr-review/reviewer) and neither path can diverge from
 * the other.
 *
 * What the runner provides, so this app does not: the queue and retry
 * semantics (a workflow run, re-runnable from the Actions UI), the
 * compute, and the credentials. There is no SQS client, no Secrets
 * Manager, and no AWS dependency here — the Anthropic key arrives as
 * an action input backed by a repository secret, and the GitHub token
 * is the one GitHub already handed the workflow.
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
  type AnthropicLike,
} from "@pr-review/ai";
import { createTokenClient } from "@pr-review/github";
import { createConsoleLogger } from "@pr-review/logging";
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
 * Reads an action input. GitHub exposes `with:` entries as
 * INPUT_<NAME> with the name uppercased and spaces replaced by
 * underscores (dashes are preserved) — the same rule @actions/core
 * implements, reproduced here so the bundle stays dependency-free.
 */
function getInput(name: string): string {
  const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return value?.trim() ?? "";
}

function requireInput(name: string): string {
  const value = getInput(name);
  if (value === "") {
    throw new Error(`Missing required action input: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const logger = createConsoleLogger();

  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (eventPath === undefined || eventPath === "") {
    throw new Error(
      "GITHUB_EVENT_PATH is not set — this action must run inside a GitHub Actions workflow",
    );
  }
  const payload: unknown = JSON.parse(await readFile(eventPath, "utf8"));
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "";

  const anthropic: AnthropicLike = createAnthropicClient({
    apiKey: requireInput("anthropic-api-key"),
  });
  const model = requireInput("model");
  // The Synthesiser (spec §16) shares the agents' client and model:
  // §16 defines no separate model configuration. It is
  // repository-independent (no GitHub tools), so one instance serves
  // the single review this process performs.
  const synthesiser = createSynthesiser({ anthropic, model });
  const client = createTokenClient({ token: requireInput("github-token") });

  const handler = createActionHandler({
    client,
    runReviewPipeline: (reviewClient, context) =>
      runReviewPipeline(
        createReviewAgents({ anthropic, model, github: reviewClient }),
        synthesiser,
        context,
        context.changedFiles,
      ),
    // Check run first; job summary when the workflow token cannot
    // create one (fork pull requests).
    publishReview: createFallbackPublisher({
      publishCheckRun: createCheckRunPublisher(client),
      summaryPath: process.env["GITHUB_STEP_SUMMARY"],
      logger,
    }),
    logger,
  });

  await handler(payload, eventName);
}

// Only runs as the action entrypoint; importing this module (tests,
// bundle smoke checks) performs no work and needs no configuration.
if (process.env["GITHUB_ACTIONS"] === "true") {
  main().catch((error: unknown) => {
    createConsoleLogger().error("review.failed", {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "Error",
    });
    process.exitCode = 1;
  });
}
