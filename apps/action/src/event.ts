/**
 * Reads the pull request out of the Actions event payload. The schema is local
 * to this app: an Actions event carries no `installation.id`.
 */
import { isSupportedPullRequestAction } from "@pr-review/schemas";
import type { ReviewTarget } from "@pr-review/reviewer";
import { z } from "zod";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA_MESSAGE = "expected a 40-character lowercase hex commit SHA";

/** The fields of a pull_request event payload the Action consumes. */
const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    base: z.object({
      sha: z.string().regex(SHA_PATTERN, SHA_MESSAGE),
    }),
    head: z.object({
      sha: z.string().regex(SHA_PATTERN, SHA_MESSAGE),
      repo: z.object({ full_name: z.string() }).nullable().optional(),
    }),
  }),
});

/** Either a pull request to review, or a reason this event is not one. */
type EventInspection =
  | { review: true; target: ReviewTarget; isFork: boolean; baseSha: string }
  | { review: false; reason: string };

/**
 * Throws only on a payload claiming to be a supported pull_request event
 * that does not match the schema; an unrelated event is ignored.
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
    // The configuration is read at this commit: it predates the PR, so
    // the branch under review cannot rewrite its own reviewers.
    baseSha: parsed.data.pull_request.base.sha,
    // Logging only: the publisher reacts to the real permission error
    // rather than predicting it from this flag.
    isFork: headRepo !== undefined && headRepo !== `${owner}/${repo}`,
  };
}
