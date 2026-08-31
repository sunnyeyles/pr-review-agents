/**
 * Telling "this token is not allowed to do that" apart from a genuine
 * failure.
 *
 * Both write paths need the distinction and must not disagree on it: a
 * fork pull request's token can create neither a check run nor a
 * review, and in both cases the right answer is to degrade rather than
 * fail the workflow.
 */

/** Reads an HTTP status off an Octokit RequestError, if there is one. */
export function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Whether a failed write means "this token lacks the permission"
 * rather than a genuine failure.
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
  //   403  the token is valid but lacks the scope — the fork case.
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
