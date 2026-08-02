/**
 * @pr-review/worker
 *
 * Review Lambda entrypoint: consumes review jobs from SQS via the
 * injectable handler in handler.ts, authenticates as the GitHub App
 * installation, loads the PR, and publishes the "AI PR Review" check
 * run (stubbed until the review agents land). The App private key is
 * read from Secrets Manager at runtime when
 * GITHUB_APP_PRIVATE_KEY_SECRET_ARN is set (deployed), and from the
 * plain environment otherwise (local/test) — see @pr-review/config.
 */
import { requireEnv, resolveSecret } from "@pr-review/config";
import { createGithubApp } from "@pr-review/github";
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
  return createWorkerHandler({
    createInstallationClient: createGithubApp({
      appId: requireEnv("GITHUB_APP_ID"),
      privateKey: await resolveSecret("GITHUB_APP_PRIVATE_KEY"),
    }),
  });
}

// Built lazily on first invocation so importing this module (e.g. in
// tests or a bundle smoke check) needs no configuration, and cached so
// the secret is fetched once per container. The GitHub App factory
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
