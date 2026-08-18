/**
 * Which pull_request webhook actions trigger a review.
 *
 * Shared rather than per-app: the webhook Lambda and the GitHub Action
 * receive the same GitHub event payload through different transports,
 * and a review must mean the same thing on both paths. Only the
 * envelope differs — a webhook delivery carries `installation.id`, an
 * Actions event does not — so each app keeps its own payload schema
 * and shares this trigger contract.
 *
 * `opened` and `reopened` start a review; `synchronize` re-reviews a
 * new head commit. Everything else (labels, assignments, closes) is
 * ignored.
 */
export const SUPPORTED_PULL_REQUEST_ACTIONS = [
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
