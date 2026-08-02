/**
 * @pr-review/worker
 *
 * Review Lambda entrypoint: consumes review jobs from SQS via the
 * injectable handler in handler.ts, authenticates as the GitHub App
 * installation, loads the PR, runs candidate findings (hard-coded
 * samples until the review agents land) through the deterministic
 * validation chain, and publishes the rendered "AI PR Review" check
 * run. Configuration comes from the environment; Secrets Manager
 * wiring lands with the infrastructure ticket.
 */
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Built lazily so importing this module (e.g. in tests) does not require
// worker configuration to be present. The GitHub App factory caches
// installation clients, so warm invocations reuse authenticated clients.
let workerHandler: WorkerHandler | undefined;

export const handler: SQSHandler = async (event) => {
  workerHandler ??= createWorkerHandler({
    createInstallationClient: createGithubApp({
      appId: requireEnv("GITHUB_APP_ID"),
      privateKey: requireEnv("GITHUB_APP_PRIVATE_KEY"),
    }),
  });
  return workerHandler(event);
};
