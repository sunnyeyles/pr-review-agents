import type { ReviewContext } from "@pr-review/ai";
import type {
  GithubInstallationClient,
  InstallationClientFactory,
} from "@pr-review/github";
import {
  renderCheckRun,
  validateFindings,
  type ReviewRunResult,
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
   * Runs the review agents against the loaded PR context (the
   * orchestrator from @pr-review/reviewer, wired with the configured
   * agents by the entrypoint). Throws when the review as a whole
   * fails, which makes the job a batch item failure so SQS retry/DLQ
   * semantics apply.
   */
  runReview: (
    client: GithubInstallationClient,
    context: ReviewContext,
  ) => Promise<ReviewRunResult>;
  /**
   * The AI Synthesiser (spec §16): refines the raw candidate findings
   * (dedupe, merge overlaps, drop weak ones, correct severity,
   * prioritise) before deterministic validation. Its output is still
   * UNTRUSTED candidate data and passes through the entire validation
   * chain unchanged. When it rejects, the handler logs
   * synthesis.failed and falls back to validating the RAW candidates —
   * a synthesis failure never fails the review.
   */
  synthesise: (candidates: readonly unknown[]) => Promise<readonly unknown[]>;
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

function logError(event: string, details: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...details }));
}

/**
 * Runs the §16 synthesis step over the raw candidates, with the two
 * deliberate non-model paths:
 *
 * - No candidates: the model call is skipped entirely — there is
 *   nothing to refine, and a clean review should not spend a model
 *   round trip or gain a failure mode (logged as synthesis.skipped).
 * - Synthesis failure (API error, invalid output, timeout): logged as
 *   synthesis.failed and the RAW candidates are returned, so the
 *   review falls back to publishing the validated raw findings.
 */
async function synthesiseCandidates(
  synthesise: WorkerHandlerDeps["synthesise"],
  rawCandidates: readonly unknown[],
  logContext: Record<string, unknown>,
): Promise<readonly unknown[]> {
  if (rawCandidates.length === 0) {
    log("synthesis.skipped", { ...logContext, reason: "no candidate findings" });
    return rawCandidates;
  }

  log("synthesis.started", {
    ...logContext,
    candidateCount: rawCandidates.length,
  });
  try {
    const refined = await synthesise(rawCandidates);
    log("synthesis.completed", {
      ...logContext,
      candidateCount: rawCandidates.length,
      refinedCount: refined.length,
    });
    return refined;
  } catch (error) {
    logError("synthesis.failed", {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
      fallback: "publishing validated raw findings",
    });
    return rawCandidates;
  }
}

async function processJob(
  job: ReviewJob,
  client: GithubInstallationClient,
  { runReview, synthesise }: Pick<WorkerHandlerDeps, "runReview" | "synthesise">,
): Promise<void> {
  const repository = `${job.owner}/${job.repo}`;
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
  log("review.loaded", {
    repository,
    pullRequestNumber: pullRequest.number,
    changedFileCount: changedFiles.length,
    diffLength: diff.length,
  });

  // The AI boundary: agents only ever PROPOSE candidate findings.
  // Everything below is the deterministic side-effect boundary — only
  // validated findings ever reach the GitHub API, and only through
  // application code.
  const review = await runReview(client, {
    owner: job.owner,
    repo: job.repo,
    pullRequest,
    changedFiles,
    diff,
  });
  for (const failure of review.agentFailures) {
    logError("agent.failed", {
      repository,
      pullRequestNumber: job.pullRequestNumber,
      agent: failure.agent,
      error: failure.error,
    });
  }

  // The §16 synthesis step sits between the raw agent output and the
  // deterministic chain. Its output is never the final authority: it
  // goes through the exact same validateFindings the raw candidates
  // would, so a fabricated file/line or padded list still dies here.
  const candidates = await synthesiseCandidates(synthesise, review.candidates, {
    repository,
    pullRequestNumber: job.pullRequestNumber,
  });

  const findings = validateFindings(candidates, changedFiles);
  // Failed lenses are noted in the check run by name only; the error
  // detail stays in the agent.failed logs above.
  const rendered = renderCheckRun(findings, review.agentFailures);

  log("findings.validated", {
    repository,
    pullRequestNumber: job.pullRequestNumber,
    candidateCount: candidates.length,
    findingCount: findings.length,
  });

  await client.createCheckRun({
    owner: job.owner,
    repo: job.repo,
    headSha: job.headSha,
    conclusion: rendered.conclusion,
    output: rendered.output,
  });
}

/**
 * Builds the review Lambda handler: for each SQS record, validate the
 * review job, authenticate as its GitHub App installation, load the PR
 * (details, changed files, diff), run the review agents through the
 * injected orchestrator, refine their raw candidates through the AI
 * Synthesiser (falling back to the raw candidates when synthesis
 * fails), pipe the result through the deterministic validation chain,
 * and publish the rendered "AI PR Review" check run. Failed records —
 * including jobs whose review failed outright (e.g. every agent
 * produced invalid output) — are reported individually via the SQS
 * partial batch response so they are retried and eventually
 * dead-lettered.
 */
export function createWorkerHandler({
  createInstallationClient,
  runReview,
  synthesise,
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
        await processJob(job, createInstallationClient(job.installationId), {
          runReview,
          synthesise,
        });
        log("review.published", {
          repository: `${job.owner}/${job.repo}`,
          pullRequestNumber: job.pullRequestNumber,
          headSha: job.headSha,
        });
      } catch (error) {
        logError("review.failed", {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}
