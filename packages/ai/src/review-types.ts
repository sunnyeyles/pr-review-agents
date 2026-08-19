/**
 * The shared shapes between the review agents (this package) and the
 * orchestrator (@pr-review/reviewer): the loaded PR context an agent
 * reviews, and the agent interface itself.
 */
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
 * One review agent. `run` resolves with CANDIDATE findings — untrusted
 * agent output that must pass the deterministic validation chain
 * (@pr-review/reviewer's validateFindings) before anything reaches
 * GitHub — and rejects when the agent fails (invalid final output,
 * turn-cap exceeded, model API error).
 */
export interface ReviewAgent {
  name: string;
  run(context: ReviewContext): Promise<readonly unknown[]>;
}
