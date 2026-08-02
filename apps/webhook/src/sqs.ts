import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { ReviewJob } from "@pr-review/schemas";

import type { EnqueueReviewJob } from "./handler.js";

/**
 * The slice of the SQS client the enqueuer needs. SQSClient satisfies
 * this structurally; tests inject a stub so no real AWS calls happen.
 */
export interface SqsSendClient {
  send(command: SendMessageCommand): Promise<unknown>;
}

export interface CreateSqsEnqueueOptions {
  queueUrl: string;
  client?: SqsSendClient;
}

/** Delivers a review job to the SQS queue as a single JSON message. */
export function createSqsEnqueue({
  queueUrl,
  client = new SQSClient({}),
}: CreateSqsEnqueueOptions): EnqueueReviewJob {
  return async (job: ReviewJob) => {
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(job),
      }),
    );
  };
}
