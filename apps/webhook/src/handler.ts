import {
  isSupportedPullRequestAction,
  reviewJobSchema,
  type ReviewJob,
} from "@pr-review/schemas";
import { z } from "zod";

import { verifyWebhookSignature } from "./verify-signature.js";

/**
 * PR actions that should trigger a review (opened / updated /
 * reopened). Re-exported from @pr-review/schemas, where it is shared
 * with the GitHub Action so both delivery paths trigger alike.
 */
export {
  SUPPORTED_PULL_REQUEST_ACTIONS,
  isSupportedPullRequestAction,
} from "@pr-review/schemas";

/**
 * The slice of an API Gateway proxy event the webhook handler needs.
 * Structurally compatible with APIGatewayProxyEventV2 so the Lambda
 * entrypoint can pass events straight through, while tests construct
 * only these fields.
 */
export interface WebhookHttpEvent {
  headers: Record<string, string | undefined>;
  body?: string | undefined;
  isBase64Encoded?: boolean | undefined;
}

export interface WebhookHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Seam for delivering a job to the queue; stubbed in tests, SQS in prod. */
export type EnqueueReviewJob = (job: ReviewJob) => Promise<void>;

export interface WebhookHandlerDeps {
  webhookSecret: string;
  enqueueReviewJob: EnqueueReviewJob;
}

export type WebhookHandler = (
  event: WebhookHttpEvent,
) => Promise<WebhookHttpResponse>;

/** Minimal shape of a payload whose action we can inspect. */
const actionOnlySchema = z.object({ action: z.string() });

/** The fields of a GitHub pull_request webhook payload we consume. */
const pullRequestEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
  pull_request: z.object({
    number: z.number(),
    head: z.object({ sha: z.string() }),
  }),
});

function response(statusCode: number, message: string): WebhookHttpResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  };
}

function getHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

/**
 * Builds the webhook Lambda handler: verify the GitHub signature,
 * filter to supported pull_request actions, extract a ReviewJob, and
 * enqueue it. No GitHub API calls and no AI work happen here.
 */
export function createWebhookHandler({
  webhookSecret,
  enqueueReviewJob,
}: WebhookHandlerDeps): WebhookHandler {
  return async (event) => {
    const rawBody = Buffer.from(
      event.body ?? "",
      event.isBase64Encoded ? "base64" : "utf8",
    );

    const signatureValid = verifyWebhookSignature({
      secret: webhookSecret,
      payload: rawBody,
      signatureHeader: getHeader(event.headers, "x-hub-signature-256"),
    });
    if (!signatureValid) {
      return response(401, "invalid signature");
    }

    const eventName = getHeader(event.headers, "x-github-event");
    if (eventName !== "pull_request") {
      return response(200, "event ignored");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return response(400, "malformed payload");
    }

    const action = actionOnlySchema.safeParse(payload);
    if (!action.success) {
      return response(400, "malformed payload");
    }
    if (!isSupportedPullRequestAction(action.data.action)) {
      return response(200, "action ignored");
    }

    const parsed = pullRequestEventSchema.safeParse(payload);
    if (!parsed.success) {
      return response(400, "malformed payload");
    }

    const job = reviewJobSchema.safeParse({
      installationId: parsed.data.installation.id,
      owner: parsed.data.repository.owner.login,
      repo: parsed.data.repository.name,
      pullRequestNumber: parsed.data.pull_request.number,
      headSha: parsed.data.pull_request.head.sha,
    } satisfies ReviewJob);
    if (!job.success) {
      return response(400, "malformed payload");
    }

    try {
      await enqueueReviewJob(job.data);
    } catch {
      return response(500, "failed to enqueue review job");
    }

    return response(202, "review job queued");
  };
}
