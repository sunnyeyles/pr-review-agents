/**
 * Which pull_request webhook actions trigger a review.
 *
 * Shared rather than app-local: what counts as a review trigger is a
 * contract, not a detail of whichever app happens to parse the event
 * payload, so the trigger list lives here while payload schemas stay
 * with their app.
 *
 * `opened` and `reopened` start a review; `synchronize` re-reviews a
 * new head commit. Everything else (labels, assignments, closes) is
 * ignored.
 */
/** The pull_request actions that trigger a review. */
const SUPPORTED_PULL_REQUEST_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
] as const;

export type SupportedPullRequestAction =
  (typeof SUPPORTED_PULL_REQUEST_ACTIONS)[number];

/** Whether a pull_request event action should trigger a review. */
export function isSupportedPullRequestAction(action: string): boolean {
  return (SUPPORTED_PULL_REQUEST_ACTIONS as readonly string[]).includes(action);
}
