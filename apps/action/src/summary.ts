/**
 * The fork fallback: delivering a review when the workflow token
 * cannot create a check run.
 *
 * GitHub hands workflows triggered by fork pull requests a read-only
 * token, so `checks: write` is unavailable and createCheckRun fails.
 * Rather than failing the workflow — which would make every fork PR
 * look broken — the Action writes the same rendered review to the
 * workflow job summary and exits cleanly. The reviewer still gets the
 * findings; only the inline annotations are lost, because annotations
 * exist only on check runs.
 *
 * Deliberately narrow: this reacts to the permission error GitHub
 * actually returns rather than trying to predict from the payload
 * whether the token will be read-only. Prediction gets it wrong for
 * same-repo PRs in workflows with a restrictive `permissions:` block.
 */
import { appendFile } from "node:fs/promises";

import type { StructuredLogger } from "@pr-review/logging";
import type {
  PublishReview,
  RenderedCheckRun,
  ReviewTarget,
} from "@pr-review/reviewer";

/** Reads an HTTP status off an Octokit RequestError, if there is one. */
export function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Whether a failed createCheckRun means "this token lacks
 * checks: write" rather than a genuine failure.
 *
 * This decides whether a review degrades gracefully or fails the
 * workflow, so both directions of error matter: too permissive and a
 * real GitHub outage renders as a clean review nobody investigates;
 * too strict and every fork pull request fails CI.
 */
export function isPermissionError(error: unknown): boolean {
  // Status alone, deliberately. Matching on message text would couple
  // the fork fallback to GitHub's wording ("Resource not accessible by
  // integration"), which is not part of any API contract and has been
  // reworded before.
  //
  //   403  the token is valid but lacks checks: write — the fork case.
  //   404  GitHub hides rather than forbids. A read-only token on a
  //        private repository gets this instead of 403, so it has to
  //        degrade too. The cost of being wrong here is asymmetric: a
  //        genuinely bad owner/repo also returns 404, but that mistake
  //        surfaces immediately as an empty review on a PR that plainly
  //        exists, whereas failing every fork PR erodes trust quietly.
  //
  // Everything else fails the workflow: 401 is a bad or expired token
  // (a configuration bug), 429 is rate limiting, 5xx is an outage, and
  // an error with no status at all is a network failure. None of those
  // may masquerade as a delivered review.
  const status = httpStatus(error);
  return status === 403 || status === 404;
}

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

export interface FallbackPublisherDeps {
  /** The check-run publisher to try first (createCheckRunPublisher). */
  publishCheckRun: PublishReview;
  /** Value of GITHUB_STEP_SUMMARY; absent outside a real runner. */
  summaryPath: string | undefined;
  logger: StructuredLogger;
}

/**
 * Wraps the check-run publisher with the job-summary fallback. A
 * permission error degrades; anything else propagates unchanged so the
 * workflow fails and the caller's retry decision still applies.
 */
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
