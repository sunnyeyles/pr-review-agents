/**
 * Reading the pull request out of the Actions event payload.
 *
 * GitHub writes the triggering webhook payload to a file and points
 * GITHUB_EVENT_PATH at it. It is the raw pull_request event minus any
 * delivery envelope: an Actions event carries no `installation.id`,
 * because the workflow token already scopes the request. The payload
 * schema below is therefore local to this app, while the trigger
 * contract it checks against is shared via @pr-review/schemas.
 */
import { isSupportedPullRequestAction } from "@pr-review/schemas";
import type { ReviewTarget } from "@pr-review/reviewer";
import { z } from "zod";

/** The fields of a pull_request event payload the Action consumes. */
const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({
      sha: z
        .string()
        .regex(
          /^[0-9a-f]{40}$/,
          "expected a 40-character lowercase hex commit SHA",
        ),
      repo: z.object({ full_name: z.string() }).nullable().optional(),
    }),
  }),
});

/**
 * The outcome of inspecting one event: either a pull request to
 * review, or a reason this event is not one. An ignored action is a
 * normal, successful no-op — most workflow triggers are not reviews.
 */
export type EventInspection =
  | { review: true; target: ReviewTarget; isFork: boolean }
  | { review: false; reason: string };

/**
 * Parses a raw Actions event payload into a review target. Throws only
 * on a payload that claims to be a supported pull_request event but
 * does not match the schema — a malformed event is a bug worth failing
 * the workflow over, whereas an unrelated event is simply ignored.
 */
export function inspectEvent(
  payload: unknown,
  eventName: string,
): EventInspection {
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    return { review: false, reason: `unsupported event: ${eventName}` };
  }

  const action = z.object({ action: z.string() }).safeParse(payload);
  if (!action.success) {
    throw new Error("event payload has no action field");
  }
  if (!isSupportedPullRequestAction(action.data.action)) {
    return { review: false, reason: `action ignored: ${action.data.action}` };
  }

  const parsed = pullRequestEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `pull_request event failed schema validation: ${parsed.error.message}`,
    );
  }

  const owner = parsed.data.repository.owner.login;
  const repo = parsed.data.repository.name;
  const headRepo = parsed.data.pull_request.head.repo?.full_name;
  return {
    review: true,
    target: {
      owner,
      repo,
      pullRequestNumber: parsed.data.pull_request.number,
      headSha: parsed.data.pull_request.head.sha,
    },
    // Recorded for logging only. Whether the check run can actually be
    // published is decided by the token GitHub handed this workflow,
    // not by where the branch lives, so the publisher reacts to the
    // real permission error rather than predicting it from this flag.
    isFork: headRepo !== undefined && headRepo !== `${owner}/${repo}`,
  };
}
