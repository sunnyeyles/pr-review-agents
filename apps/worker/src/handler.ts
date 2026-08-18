import type { ReviewContext } from "@pr-review/ai";
import type {
  GithubInstallationClient,
  InstallationClientFactory,
} from "@pr-review/github";
import { createConsoleLogger, type StructuredLogger } from "@pr-review/logging";
import {
  reviewCorrelation,
  reviewPullRequest,
  type ReviewPipelineResult,
} from "@pr-review/reviewer";
import { reviewJobSchema, type ReviewJob } from "@pr-review/schemas";

/**
 * The slice of an SQS event the worker needs. Structurally compatible
 * with aws-lambda's SQSEvent so the Lambda entrypoint can pass events
 * straight through, while tests construct only these fields.
 */
export interface WorkerSqsRecord {
  messageId: string;
  body: string;
}

export interface WorkerSqsEvent {
  Records: WorkerSqsRecord[];
}

/** SQS partial batch response (reportBatchItemFailures). */
export interface WorkerSqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

export interface WorkerHandlerDeps {
  createInstallationClient: InstallationClientFactory;
  /**
   * Runs the full review pipeline (@pr-review/reviewer's LangGraph
   * StateGraph). Throws when every agent failed, which makes the job
   * a batch item failure so SQS retry/DLQ semantics apply. A
   * synthesis failure never throws — it is reported on the result and
   * the validated raw candidates are published.
   */
  runReviewPipeline: (
    client: GithubInstallationClient,
    context: ReviewContext,
  ) => Promise<ReviewPipelineResult>;
  /**
   * Structured lifecycle logger: every event of one review
   * carries repository, PR number, and head SHA so an operator can
   * answer "what happened to the review for PR N?" from CloudWatch
   * logs alone. Defaults to the console logger; tests inject a
   * capturing logger.
   */
  logger?: StructuredLogger | undefined;
}

export type WorkerHandler = (
  event: WorkerSqsEvent,
) => Promise<WorkerSqsBatchResponse>;

/**
 * Parses and validates one queued review job. Throws on malformed
 * bodies so the record is reported as a batch item failure and SQS
 * retry / dead-letter semantics apply.
 */
function parseReviewJob(body: string): ReviewJob {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error(`review job body is not valid JSON: ${String(error)}`);
  }
  const job = reviewJobSchema.safeParse(payload);
  if (!job.success) {
    throw new Error(`review job failed schema validation: ${job.error.message}`);
  }
  return job.data;
}

/**
 * Builds the review Lambda handler: for each SQS record, validate the
 * review job, authenticate as its GitHub App installation, and hand
 * the pull request to reviewPullRequest (@pr-review/reviewer) — the
 * shared body that loads the PR, runs the pipeline, and publishes the
 * "AI PR Review" check run. Failed records — including jobs whose
 * review failed outright (e.g. every agent produced invalid output) —
 * are reported individually via the SQS partial batch response so they
 * are retried and eventually dead-lettered.
 *
 * Everything specific to this delivery path lives here: SQS record
 * parsing, installation authentication, and partial-batch semantics.
 * The review itself is identical to the one the GitHub Action runs.
 */
export function createWorkerHandler({
  createInstallationClient,
  runReviewPipeline,
  logger = createConsoleLogger(),
}: WorkerHandlerDeps): WorkerHandler {
  return async (event) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];

    for (const record of event.Records) {
      let job: ReviewJob | undefined;
      try {
        job = parseReviewJob(record.body);
        logger.info("review.started", reviewCorrelation(job));
        await reviewPullRequest(job, {
          client: createInstallationClient(job.installationId),
          runReviewPipeline,
          logger,
        });
      } catch (error) {
        logger.error("review.failed", {
          ...(job === undefined ? {} : reviewCorrelation(job)),
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "Error",
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}
