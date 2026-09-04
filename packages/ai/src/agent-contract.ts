/** The shared shapes between the review agents and the orchestrator. */
import type { ChangedFile, PullRequestDetails } from "@pr-review/github";

/** Everything loaded about a PR before any agent runs. */
export interface ReviewContext {
  owner: string;
  repo: string;
  pullRequest: PullRequestDetails;
  changedFiles: readonly ChangedFile[];
  diff: string;
}

/**
 * One review agent. `run` resolves with untrusted candidate findings
 * that must pass validateFindings before anything reaches GitHub.
 */
export interface ReviewAgent {
  name: string;
  run(context: ReviewContext): Promise<readonly unknown[]>;
}
