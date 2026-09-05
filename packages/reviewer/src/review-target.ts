import type { PullRequestRef } from "@pr-review/github";

/** The pull request one review runs against, at one commit. */
export interface ReviewTarget extends PullRequestRef {
  headSha: string;
}

/** The correlation fields every event of one review carries. */
export function reviewCorrelation(
  target: ReviewTarget,
): Record<string, unknown> {
  return {
    repository: `${target.owner}/${target.repo}`,
    pullRequestNumber: target.pullRequestNumber,
    headSha: target.headSha,
  };
}
