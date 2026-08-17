/**
 * @pr-review/worker
 *
 * Review Lambda entrypoint: wires the dependencies the injectable
 * handler in handler.ts needs, then runs the @pr-review/reviewer
 * pipeline per SQS job.
 *
 * Configuration: the GitHub App private key and the Anthropic API key
 * are read from Secrets Manager at runtime when their *_SECRET_ARN
 * variables are set (deployed), and from the plain environment
 * otherwise (local/test) — see @pr-review/config. The model comes from
 * ANTHROPIC_MODEL and is never hard-coded.
 */
import {
  createAnthropicClient,
  createReviewAgents,
  type AnthropicLike,
} from "@pr-review/ai";
import { requireEnv, resolveSecret } from "@pr-review/config";
import { createGithubApp } from "@pr-review/github";
import { createSynthesiser, runReviewPipeline } from "@pr-review/reviewer";
import type { SQSHandler } from "aws-lambda";

import { createWorkerHandler, type WorkerHandler } from "./handler.js";

export {
  createWorkerHandler,
  type WorkerHandler,
  type WorkerHandlerDeps,
  type WorkerSqsBatchResponse,
  type WorkerSqsEvent,
  type WorkerSqsRecord,
} from "./handler.js";

async function buildWorkerHandler(): Promise<WorkerHandler> {
  const anthropic: AnthropicLike = createAnthropicClient({
    apiKey: await resolveSecret("ANTHROPIC_API_KEY"),
  });
  const model = requireEnv("ANTHROPIC_MODEL");
  // The Synthesiser shares the agents' client and model:
  // defines no separate model configuration, so ANTHROPIC_MODEL is
  // reused. It is installation-independent (no GitHub tools), so one
  // instance serves every job.
  const synthesiser = createSynthesiser({ anthropic, model });

  return createWorkerHandler({
    createInstallationClient: createGithubApp({
      appId: requireEnv("GITHUB_APP_ID"),
      privateKey: await resolveSecret("GITHUB_APP_PRIVATE_KEY"),
    }),
    // The pipeline graph runs the agents, the Synthesiser, and the
    // deterministic validation chain for one job; all three agents are
    // built per call because their tools must dispatch to that job's
    // installation-authenticated GitHub client.
    runReviewPipeline: (client, context) =>
      runReviewPipeline(
        createReviewAgents({ anthropic, model, github: client }),
        synthesiser,
        context,
        context.changedFiles,
      ),
  });
}

// Built lazily on first invocation so importing this module (e.g. in
// tests or a bundle smoke check) needs no configuration, and cached so
// the secrets are fetched once per container. The GitHub App factory
// caches installation clients, so warm invocations reuse authenticated
// clients. Reset on failure so a transient Secrets Manager error does
// not poison warm invocations.
let workerHandlerPromise: Promise<WorkerHandler> | undefined;

export const handler: SQSHandler = async (event) => {
  workerHandlerPromise ??= buildWorkerHandler().catch((error: unknown) => {
    workerHandlerPromise = undefined;
    throw error;
  });
  const workerHandler = await workerHandlerPromise;
  return workerHandler(event);
};
