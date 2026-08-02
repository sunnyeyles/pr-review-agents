/**
 * @pr-review/worker
 *
 * Review Lambda: consumes review jobs from SQS, runs the review agents,
 * and publishes GitHub Check Runs. Populated in later tickets; this
 * placeholder only wires the app into the workspace.
 */
import { AI_PACKAGE } from "@pr-review/ai";
import { GITHUB_PACKAGE } from "@pr-review/github";
import { REVIEWER_PACKAGE } from "@pr-review/reviewer";
import { SCHEMAS_PACKAGE } from "@pr-review/schemas";

export const WORKER_APP = "@pr-review/worker";

export const workerAppDependencies = [
  SCHEMAS_PACKAGE,
  GITHUB_PACKAGE,
  AI_PACKAGE,
  REVIEWER_PACKAGE,
] as const;
