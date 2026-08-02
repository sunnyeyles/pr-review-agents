import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { ReviewJob } from "@pr-review/schemas";
import { describe, expect, it, vi } from "vitest";

import { createSqsEnqueue } from "./sqs.js";

const job: ReviewJob = {
  installationId: 12345678,
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

describe("createSqsEnqueue", () => {
  it("sends exactly one SQS message containing the JSON-serialised job", async () => {
    const send = vi.fn<(command: SendMessageCommand) => Promise<unknown>>(
      async () => ({}),
    );
    const enqueue = createSqsEnqueue({
      queueUrl: "https://sqs.eu-central-1.amazonaws.com/123456789012/review-jobs",
      client: { send },
    });

    await enqueue(job);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command?.input.QueueUrl).toBe(
      "https://sqs.eu-central-1.amazonaws.com/123456789012/review-jobs",
    );
    expect(JSON.parse(command?.input.MessageBody ?? "")).toEqual(job);
  });

  it("propagates SQS failures to the caller", async () => {
    const send = vi.fn(async () => {
      throw new Error("sqs unavailable");
    });
    const enqueue = createSqsEnqueue({
      queueUrl: "https://sqs.eu-central-1.amazonaws.com/123456789012/review-jobs",
      client: { send },
    });

    await expect(enqueue(job)).rejects.toThrow("sqs unavailable");
  });
});
