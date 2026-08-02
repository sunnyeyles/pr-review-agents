/**
 * @pr-review/webhook
 *
 * Webhook Lambda entrypoint: verifies GitHub webhook signatures and
 * enqueues review jobs onto SQS via the injectable handler in
 * handler.ts. Configuration comes from the environment; Secrets
 * Manager wiring lands with the infrastructure ticket.
 */
import { SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

import { createWebhookHandler, type WebhookHandler } from "./handler.js";
import { createSqsEnqueue } from "./sqs.js";

export {
  createWebhookHandler,
  SUPPORTED_PULL_REQUEST_ACTIONS,
  type EnqueueReviewJob,
  type WebhookHandler,
  type WebhookHandlerDeps,
  type WebhookHttpEvent,
  type WebhookHttpResponse,
} from "./handler.js";
export { createSqsEnqueue, type CreateSqsEnqueueOptions, type SqsSendClient } from "./sqs.js";
export { verifyWebhookSignature, type VerifyWebhookSignatureInput } from "./verify-signature.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Created at module scope so the connection is reused across warm invocations.
const sqsClient = new SQSClient({});

// Built lazily so importing this module (e.g. in tests) does not require
// webhook configuration to be present.
let webhookHandler: WebhookHandler | undefined;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  webhookHandler ??= createWebhookHandler({
    webhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
    enqueueReviewJob: createSqsEnqueue({
      queueUrl: requireEnv("REVIEW_QUEUE_URL"),
      client: sqsClient,
    }),
  });
  return webhookHandler(event);
};
