/**
 * @pr-review/webhook
 *
 * Webhook Lambda entrypoint: verifies GitHub webhook signatures and
 * enqueues review jobs onto SQS via the injectable handler in
 * handler.ts. The webhook secret is read from Secrets Manager at
 * runtime when GITHUB_WEBHOOK_SECRET_SECRET_ARN is set (deployed), and
 * from the plain environment otherwise (local/test) — see
 * @pr-review/config.
 */
import { SQSClient } from "@aws-sdk/client-sqs";
import { requireEnv, resolveSecret } from "@pr-review/config";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

import { createWebhookHandler, type WebhookHandler } from "./handler.js";
import { createSqsEnqueue } from "./sqs.js";

export {
  createWebhookHandler,
  SUPPORTED_PULL_REQUEST_ACTIONS,
  isSupportedPullRequestAction,
  type EnqueueReviewJob,
  type WebhookHandler,
  type WebhookHandlerDeps,
  type WebhookHttpEvent,
  type WebhookHttpResponse,
} from "./handler.js";
export { createSqsEnqueue, type CreateSqsEnqueueOptions, type SqsSendClient } from "./sqs.js";
export { verifyWebhookSignature, type VerifyWebhookSignatureInput } from "./verify-signature.js";

// Created at module scope so the connection is reused across warm invocations.
const sqsClient = new SQSClient({});

async function buildWebhookHandler(): Promise<WebhookHandler> {
  return createWebhookHandler({
    webhookSecret: await resolveSecret("GITHUB_WEBHOOK_SECRET"),
    enqueueReviewJob: createSqsEnqueue({
      queueUrl: requireEnv("REVIEW_QUEUE_URL"),
      client: sqsClient,
    }),
  });
}

// Built lazily on first invocation so importing this module (e.g. in
// tests or a bundle smoke check) needs no configuration, and cached so
// the secret is fetched once per container. Reset on failure so a
// transient Secrets Manager error does not poison warm invocations.
let webhookHandlerPromise: Promise<WebhookHandler> | undefined;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  webhookHandlerPromise ??= buildWebhookHandler().catch((error: unknown) => {
    webhookHandlerPromise = undefined;
    throw error;
  });
  const webhookHandler = await webhookHandlerPromise;
  return webhookHandler(event);
};
