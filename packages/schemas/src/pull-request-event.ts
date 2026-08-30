/**
 * Which pull_request webhook actions trigger a review. Shared, because
 * the trigger list is a contract; payload schemas stay with their app.
 */
/** The pull_request actions that trigger a review. */
const SUPPORTED_PULL_REQUEST_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
] as const;

/** Whether a pull_request event action should trigger a review. */
export function isSupportedPullRequestAction(action: string): boolean {
  return (SUPPORTED_PULL_REQUEST_ACTIONS as readonly string[]).includes(action);
}
