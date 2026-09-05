/**
 * Telling "this token is not allowed to do that" apart from a real failure.
 * Both write paths need the distinction and must not disagree on it.
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
 * Whether a failed write means the token lacks the permission. Too permissive
 * hides a GitHub outage; too strict fails every fork pull request.
 */
export function isPermissionError(error: unknown): boolean {
  // Status alone: GitHub's message wording is not part of any API contract.
  // 404 too, not just 403 — GitHub hides a private repo from a read-only token.
  const status = httpStatus(error);
  return status === 403 || status === 404;
}
