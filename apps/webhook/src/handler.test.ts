import { createHmac } from "node:crypto";

import type { ReviewJob } from "@pr-review/schemas";
import { describe, expect, it, vi } from "vitest";

import { createWebhookHandler, type WebhookHttpEvent } from "./handler.js";

const secret = "test-webhook-secret";

/**
 * A GitHub pull_request webhook payload trimmed to the fields the
 * handler cares about (plus a few realistic extras it must ignore).
 */
const pullRequestPayload = {
  action: "opened",
  number: 42,
  pull_request: {
    number: 42,
    title: "Add rate limiting to the sessions endpoint",
    state: "open",
    head: {
      ref: "feature/rate-limit",
      sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    },
    base: { ref: "main" },
  },
  repository: {
    name: "example-service",
    full_name: "octo-org/example-service",
    owner: { login: "octo-org" },
  },
  installation: { id: 12345678 },
  sender: { login: "octocat" },
};

const expectedJob: ReviewJob = {
  installationId: 12345678,
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

function sign(body: string | Buffer, key: string = secret): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

interface EventOptions {
  payload?: unknown;
  rawBody?: string;
  eventName?: string;
  signature?: string | null;
  base64?: boolean;
  headerCase?: "lower" | "canonical";
}

function makeEvent(options: EventOptions = {}): WebhookHttpEvent {
  const rawBody =
    options.rawBody ?? JSON.stringify(options.payload ?? pullRequestPayload);
  const signature =
    options.signature === undefined ? sign(rawBody) : options.signature;
  const eventName = options.eventName ?? "pull_request";

  const headers: Record<string, string | undefined> =
    options.headerCase === "canonical"
      ? {
          "Content-Type": "application/json",
          "X-GitHub-Event": eventName,
          ...(signature === null ? {} : { "X-Hub-Signature-256": signature }),
        }
      : {
          "content-type": "application/json",
          "x-github-event": eventName,
          ...(signature === null ? {} : { "x-hub-signature-256": signature }),
        };

  return {
    headers,
    body: options.base64
      ? Buffer.from(rawBody, "utf8").toString("base64")
      : rawBody,
    isBase64Encoded: options.base64 ?? false,
  };
}

function makeHandler() {
  const enqueueReviewJob = vi.fn<(job: ReviewJob) => Promise<void>>(
    async () => {},
  );
  const handler = createWebhookHandler({ webhookSecret: secret, enqueueReviewJob });
  return { handler, enqueueReviewJob };
}

describe("createWebhookHandler", () => {
  it.each(["opened", "synchronize", "reopened"])(
    "enqueues exactly one review job for a correctly signed %s event",
    async (action) => {
      const { handler, enqueueReviewJob } = makeHandler();

      const response = await handler(
        makeEvent({ payload: { ...pullRequestPayload, action } }),
      );

      expect(response.statusCode).toBe(202);
      expect(enqueueReviewJob).toHaveBeenCalledTimes(1);
      expect(enqueueReviewJob).toHaveBeenCalledWith(expectedJob);
    },
  );

  it("accepts canonical-cased headers as sent by GitHub", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const response = await handler(makeEvent({ headerCase: "canonical" }));

    expect(response.statusCode).toBe(202);
    expect(enqueueReviewJob).toHaveBeenCalledTimes(1);
  });

  it("verifies the signature against the raw bytes of a base64-encoded body", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const response = await handler(makeEvent({ base64: true }));

    expect(response.statusCode).toBe(202);
    expect(enqueueReviewJob).toHaveBeenCalledWith(expectedJob);
  });

  it("rejects an invalid signature with 401 and enqueues nothing", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const response = await handler(
      makeEvent({ signature: sign(JSON.stringify(pullRequestPayload), "wrong-secret") }),
    );

    expect(response.statusCode).toBe(401);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("rejects a signature over a tampered body with 401 and enqueues nothing", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const tampered = JSON.stringify({
      ...pullRequestPayload,
      repository: {
        ...pullRequestPayload.repository,
        owner: { login: "evil-org" },
      },
    });
    const response = await handler(
      makeEvent({ rawBody: tampered, signature: sign(JSON.stringify(pullRequestPayload)) }),
    );

    expect(response.statusCode).toBe(401);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header with 401 and enqueues nothing", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const response = await handler(makeEvent({ signature: null }));

    expect(response.statusCode).toBe(401);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("acknowledges non-PR events with 2xx without enqueueing", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const pushPayload = {
      ref: "refs/heads/main",
      repository: pullRequestPayload.repository,
      installation: pullRequestPayload.installation,
    };
    const response = await handler(
      makeEvent({ payload: pushPayload, eventName: "push" }),
    );

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("acknowledges unsupported PR actions with 2xx without enqueueing", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const response = await handler(
      makeEvent({ payload: { ...pullRequestPayload, action: "labeled" } }),
    );

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed but unparseable JSON body without enqueueing", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const response = await handler(makeEvent({ rawBody: "not-json{" }));

    expect(response.statusCode).toBe(400);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("returns 400 for a supported PR event missing required fields without enqueueing", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const { installation: _installation, ...withoutInstallation } =
      pullRequestPayload;
    const response = await handler(
      makeEvent({ payload: withoutInstallation }),
    );

    expect(response.statusCode).toBe(400);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("rejects an empty body with 401 and enqueues nothing", async () => {
    const { handler, enqueueReviewJob } = makeHandler();

    const response = await handler({ headers: {} });

    expect(response.statusCode).toBe(401);
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("returns 500 when enqueueing fails", async () => {
    const { handler, enqueueReviewJob } = makeHandler();
    enqueueReviewJob.mockRejectedValueOnce(new Error("sqs unavailable"));

    const response = await handler(makeEvent());

    expect(response.statusCode).toBe(500);
  });

  it("never reflects payload contents into the response body", async () => {
    const { handler } = makeHandler();

    const response = await handler(makeEvent());

    expect(response.body).not.toContain("octo-org");
  });
});
