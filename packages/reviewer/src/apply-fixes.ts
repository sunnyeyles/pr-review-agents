/**
 * Commits verified patches to the pull request branch. Deterministic code
 * decides what is written; the agents only ever proposed the text.
 */
import {
  httpStatus,
  isPermissionError,
  type GithubInstallationClient,
} from "@pr-review/github";
import type { StructuredLogger } from "@pr-review/logging";

import { fixCount } from "./finding-format.js";
import { reviewCorrelation, type ReviewTarget } from "./review-target.js";
import type { PatchedFile } from "./validate-patches.js";

/** Names this system's own commits, so a later run does not fix its own fix. */
export const FIX_COMMIT_MARKER = "pr-review-agents: automated fix";

/** Whether a commit was written by this system. */
export function isFixCommit(message: string): boolean {
  return message.includes(FIX_COMMIT_MARKER);
}

/** GitHub's status for a ref update that is not a fast-forward. */
const UNPROCESSABLE = 422;

export type FixOutcome =
  | { status: "applied"; sha: string }
  /** The push could not happen; the patches become suggestions instead. */
  | { status: "unavailable"; reason: string }
  /** There was nothing to push. */
  | { status: "skipped"; reason: string };

export interface FixInput {
  /** The pull request's head branch, in the repository being reviewed. */
  branch: string;
  files: readonly PatchedFile[];
  patchCount: number;
}

interface FixDeps {
  client: GithubInstallationClient;
  logger: StructuredLogger;
}

function commitMessage(patchCount: number): string {
  return `Apply ${fixCount(patchCount)} from the AI review\n\n${FIX_COMMIT_MARKER}`;
}

/**
 * Never throws for a cause the pull request can recover from: a read-only
 * token and a branch that moved both degrade to "unavailable".
 */
export async function applyFixes(
  target: ReviewTarget,
  input: FixInput,
  deps: FixDeps,
): Promise<FixOutcome> {
  const fields = reviewCorrelation(target);
  if (input.files.length === 0) {
    return { status: "skipped", reason: "no verified patch" };
  }

  try {
    const tip = await deps.client.getBranchTip({
      owner: target.owner,
      repo: target.repo,
      branch: input.branch,
    });
    if (tip !== target.headSha) {
      // The review describes a commit that is no longer the branch, so its
      // line numbers no longer describe the branch either.
      deps.logger.info("review.fixes.degraded", {
        ...fields,
        reason: "the branch moved during the review",
        branchTip: tip,
      });
      return { status: "unavailable", reason: "the branch moved during the review" };
    }

    const commit = await deps.client.createCommitOnBranch({
      owner: target.owner,
      repo: target.repo,
      branch: input.branch,
      baseSha: target.headSha,
      message: commitMessage(input.patchCount),
      files: input.files,
    });
    deps.logger.info("review.fixes.applied", {
      ...fields,
      commitSha: commit.sha,
      patchCount: input.patchCount,
      files: input.files.map((file) => file.path),
    });
    return { status: "applied", sha: commit.sha };
  } catch (error) {
    const status = httpStatus(error);
    if (!isPermissionError(error) && status !== UNPROCESSABLE) {
      throw error;
    }
    const reason =
      status === UNPROCESSABLE
        ? "the branch moved during the review"
        : "the workflow token cannot write to this branch";
    deps.logger.info("review.fixes.degraded", { ...fields, reason, status });
    return { status: "unavailable", reason };
  }
}
