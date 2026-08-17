import type { ReviewContext } from "@pr-review/ai";
import type {
  GithubInstallationClient,
  InstallationClientFactory,
} from "@pr-review/github";
import { createConsoleLogger, type StructuredLogger } from "@pr-review/logging";
import { renderCheckRun, type ReviewPipelineResult } from "@pr-review/reviewer";
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
   * StateGraph): the review agents fan out over
   * the loaded PR context, their raw candidates are refined by the AI
   * Synthesiser, and the deterministic validation chain produces the
   * final findings. Throws when every agent failed, which makes the
   * job a batch item failure so SQS retry/DLQ semantics apply. A
   * synthesis failure never throws — it is reported on the result and
   * the handler falls back to publishing the validated raw candidates.
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

/** The correlation fields every event of one review carries. */
function correlation(job: ReviewJob): Record<string, unknown> {
  return {
    repository: `${job.owner}/${job.repo}`,
    pullRequestNumber: job.pullRequestNumber,
    headSha: job.headSha,
  };
}

/**
 * Logs the synthesis outcome the pipeline already computed. The
 * two non-model paths carry their own event: a clean review (zero
 * candidates) logs synthesis.skipped; a synthesis failure logs
 * synthesis.failed and notes the fallback — the raw candidates still
 * flow through validateFindings inside the pipeline, so the review
 * never dies from a synthesis failure.
 */
function logSynthesisOutcome(
  logger: StructuredLogger,
  job: ReviewJob,
  review: ReviewPipelineResult,
): void {
  const fields = correlation(job);
  if (review.synthesisOutcome === "skipped") {
    logger.info("synthesis.skipped", { ...fields, reason: "no candidate findings" });
    return;
  }

  logger.info("synthesis.started", {
    ...fields,
    candidateCount: review.candidates.length,
  });
  if (review.synthesisOutcome === "completed") {
    logger.info("synthesis.completed", {
      ...fields,
      candidateCount: review.candidates.length,
      refinedCount: review.synthesisedCandidateCount,
      inputTokens: review.synthesisUsage.inputTokens,
      outputTokens: review.synthesisUsage.outputTokens,
      durationMs: review.synthesisDurationMs,
    });
    return;
  }

  logger.error("synthesis.failed", {
    ...fields,
    error: review.synthesisError,
    errorName: review.synthesisErrorName,
    durationMs: review.synthesisDurationMs,
    fallback: "publishing validated raw findings",
  });
}

async function processJob(
  job: ReviewJob,
  client: GithubInstallationClient,
  logger: StructuredLogger,
  { runReviewPipeline }: Pick<WorkerHandlerDeps, "runReviewPipeline">,
): Promise<void> {
  const fields = correlation(job);
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
  logger.info("review.loaded", {
    ...fields,
    changedFileCount: changedFiles.length,
    diffLength: diff.length,
  });

  // The AI boundary: the pipeline's agent nodes only ever PROPOSE
  // candidate findings, and its synthesise node only ever REFINES
  // them. The validate node inside the pipeline is the deterministic
  // side-effect boundary — only its output ever reaches the GitHub
  // API, and only through application code below.
  const review = await runReviewPipeline(client, {
    owner: job.owner,
    repo: job.repo,
    pullRequest,
    changedFiles,
    diff,
  });
  // Failed lenses are noted in the check run by name only; the error
  // detail was already logged as agent.failed by the agent runtime at
  // failure time (see agent-runtime.ts) — the worker never re-emits it.
  logSynthesisOutcome(logger, job, review);

  logger.info("findings.validated", {
    ...fields,
    candidateCount: review.synthesisedCandidateCount,
    findingCount: review.findings.length,
  });

  const rendered = renderCheckRun(review.findings, review.agentFailures);
  await client.createCheckRun({
    owner: job.owner,
    repo: job.repo,
    headSha: job.headSha,
    conclusion: rendered.conclusion,
    output: rendered.output,
  });

  logger.info("review.published", {
    ...fields,
    findingCount: review.findings.length,
  });
}

/**
 * Builds the review Lambda handler: for each SQS record, validate the
 * review job, authenticate as its GitHub App installation, load the PR
 * (details, changed files, diff), run the full review pipeline (the
 * agents, the AI Synthesiser, and the deterministic validation chain,
 * all one LangGraph StateGraph), and publish the rendered "AI PR
 * Review" check run. Failed records — including jobs whose review
 * failed outright (e.g. every agent produced invalid output) — are
 * reported individually via the SQS partial batch response so they are
 * retried and eventually dead-lettered.
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
        logger.info("review.started", correlation(job));
        await processJob(job, createInstallationClient(job.installationId), logger, {
          runReviewPipeline,
        });
      } catch (error) {
        logger.error("review.failed", {
          ...(job === undefined ? {} : correlation(job)),
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
