/** The pull request one review runs against, and the fields its events carry. */

/** The pull request one review runs against. */
export interface ReviewTarget {
  owner: string;
  repo: string;
  pullRequestNumber: number;
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
