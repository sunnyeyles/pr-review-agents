import type {
  ChangedFile,
  GithubInstallationClient,
  InstallationClientFactory,
  PullRequestDetails,
} from "@pr-review/github";
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

function log(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...details }));
}

function stubCheckRunOutput(
  pullRequest: PullRequestDetails,
  changedFiles: ChangedFile[],
  diff: string,
): { title: string; summary: string } {
  return {
    title: "AI review pending",
    summary: [
      "The AI review pipeline is connected, but automated findings are not generated yet.",
      "",
      `Loaded pull request #${pullRequest.number} ("${pullRequest.title}") with ` +
        `${changedFiles.length} changed file(s) and a ${diff.length}-character diff. ` +
        "AI findings will appear here in an upcoming release.",
    ].join("\n"),
  };
}

async function processJob(
  job: ReviewJob,
  client: GithubInstallationClient,
): Promise<void> {
  const ref = {
    owner: job.owner,
    repo: job.repo,
    pullRequestNumber: job.pullRequestNumber,
  };
  const [pullRequest, changedFiles, diff] = await Promise.all([
    client.getPullRequest(ref),
    client.listChangedFiles(ref),
    client.getDiff(ref),
  ]);

  await client.createCheckRun({
    owner: job.owner,
    repo: job.repo,
    headSha: job.headSha,
    conclusion: "neutral",
    output: stubCheckRunOutput(pullRequest, changedFiles, diff),
  });
}

/**
 * Builds the review Lambda handler: for each SQS record, validate the
 * review job, authenticate as its GitHub App installation, load the PR
 * (details, changed files, diff), and publish the stub "AI PR Review"
 * check run. Failed records are reported individually via the SQS
 * partial batch response so one bad message neither poisons the batch
 * nor gets silently dropped.
 */
export function createWorkerHandler({
  createInstallationClient,
}: WorkerHandlerDeps): WorkerHandler {
  return async (event) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];

    for (const record of event.Records) {
      try {
        const job = parseReviewJob(record.body);
        log("review.started", {
          repository: `${job.owner}/${job.repo}`,
          pullRequestNumber: job.pullRequestNumber,
          headSha: job.headSha,
        });
        await processJob(job, createInstallationClient(job.installationId));
        log("review.published", {
          repository: `${job.owner}/${job.repo}`,
          pullRequestNumber: job.pullRequestNumber,
          headSha: job.headSha,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "review.failed",
            messageId: record.messageId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}
