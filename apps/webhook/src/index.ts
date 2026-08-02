/**
 * @pr-review/webhook
 *
 * Webhook Lambda: verifies GitHub webhook signatures and enqueues
 * review jobs onto SQS. Populated in later tickets; this placeholder
 * only wires the app into the workspace.
 */
import { GITHUB_PACKAGE } from "@pr-review/github";
import { SCHEMAS_PACKAGE } from "@pr-review/schemas";

export const WEBHOOK_APP = "@pr-review/webhook";

export const webhookAppDependencies = [SCHEMAS_PACKAGE, GITHUB_PACKAGE] as const;
