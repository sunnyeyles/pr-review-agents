/**
 * The fork fallback: without permission to create a check run, the review goes
 * to the job summary. Reacts to the real error, never predicts it.
 */
import { appendFile } from "node:fs/promises";

import { httpStatus, isPermissionError } from "@pr-review/github";
import type { StructuredLogger } from "@pr-review/logging";
import type {
  PublishReview,
  RenderedCheckRun,
  ReviewTarget,
} from "@pr-review/reviewer";

export { httpStatus, isPermissionError };

/** Renders the review as markdown for the workflow job summary. */
export function renderJobSummary(
  target: ReviewTarget,
  rendered: RenderedCheckRun,
): string {
  const lines = [
    `## AI PR Review — ${rendered.output.title}`,
    "",
    rendered.output.summary,
    "",
    `<sub>Posted to the job summary because this workflow's token cannot ` +
      `create check runs (usually a fork pull request). Inline annotations ` +
      `are unavailable here; findings list their file and line above. ` +
      `Reviewed ${target.owner}/${target.repo}#${target.pullRequestNumber} ` +
      `at \`${target.headSha.slice(0, 7)}\`.</sub>`,
    "",
  ];
  return lines.join("\n");
}

/** Appends markdown to the workflow job summary, if one is available. */
export async function appendJobSummary(
  markdown: string,
  summaryPath: string | undefined,
): Promise<boolean> {
  if (summaryPath === undefined || summaryPath.length === 0) {
    return false;
  }
  await appendFile(summaryPath, markdown, "utf8");
  return true;
}

interface FallbackPublisherDeps {
  /** The check-run publisher to try first (createCheckRunPublisher). */
  publishCheckRun: PublishReview;
  /** Value of GITHUB_STEP_SUMMARY; absent outside a real runner. */
  summaryPath: string | undefined;
  logger: StructuredLogger;
}

/** A permission error degrades to the job summary; anything else propagates. */
export function createFallbackPublisher({
  publishCheckRun,
  summaryPath,
  logger,
}: FallbackPublisherDeps): PublishReview {
  return async (target, rendered) => {
    try {
      await publishCheckRun(target, rendered);
    } catch (error) {
      if (!isPermissionError(error)) {
        throw error;
      }
      const wrote = await appendJobSummary(
        renderJobSummary(target, rendered),
        summaryPath,
      );
      if (!wrote) {
        throw error;
      }
      logger.info("review.published.degraded", {
        repository: `${target.owner}/${target.repo}`,
        pullRequestNumber: target.pullRequestNumber,
        headSha: target.headSha,
        surface: "job-summary",
        reason: "workflow token cannot create check runs",
        status: httpStatus(error),
      });
    }
  };
}
