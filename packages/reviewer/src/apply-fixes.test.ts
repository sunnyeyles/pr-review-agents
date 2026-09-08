import type {
  CreateCommitInput,
  GithubInstallationClient,
} from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it, vi } from "vitest";

import { FIX_COMMIT_MARKER, applyFixes, isFixCommit } from "./apply-fixes.js";
import type { ReviewTarget } from "./review-target.js";

const target: ReviewTarget = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "head1234",
};

const files = [{ path: "src/service.ts", content: "const fixed = true;\n" }];

/** An Octokit RequestError carries the status the client branches on. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function makeDeps(
  overrides: Partial<{
    getBranchTip: () => Promise<string>;
    createCommitOnBranch: (input: CreateCommitInput) => Promise<{ sha: string }>;
  }> = {},
) {
  const getBranchTip = vi.fn(overrides.getBranchTip ?? (async () => target.headSha));
  const createCommitOnBranch = vi.fn<
    (input: CreateCommitInput) => Promise<{ sha: string }>
  >(overrides.createCommitOnBranch ?? (async () => ({ sha: "newsha99" })));
  const { logger, entries } = createCapturingLogger();
  const client = { getBranchTip, createCommitOnBranch } as unknown as GithubInstallationClient;
  return { deps: { client, logger }, getBranchTip, createCommitOnBranch, entries };
}

describe("isFixCommit", () => {
  it("recognises a commit this system wrote", () => {
    expect(isFixCommit(`Apply 2 fixes\n\n${FIX_COMMIT_MARKER}`)).toBe(true);
  });

  it("does not claim an ordinary commit", () => {
    expect(isFixCommit("Rate limit sessions")).toBe(false);
  });
});

describe("applyFixes", () => {
  it("commits the patched files onto the head branch", async () => {
    const { deps, createCommitOnBranch } = makeDeps();

    const outcome = await applyFixes(
      target,
      { branch: "feature/rate-limit", files, patchCount: 2 },
      deps,
    );

    expect(outcome).toEqual({ status: "applied", sha: "newsha99" });
    expect(createCommitOnBranch).toHaveBeenCalledExactlyOnceWith({
      owner: "octo-org",
      repo: "example-service",
      branch: "feature/rate-limit",
      baseSha: "head1234",
      message: `Apply 2 fixes from the AI review\n\n${FIX_COMMIT_MARKER}`,
      files,
    });
  });

  it("marks its own commit so a later run does not fix the fix", async () => {
    const { deps, createCommitOnBranch } = makeDeps();

    await applyFixes(target, { branch: "main", files, patchCount: 1 }, deps);

    const message = createCommitOnBranch.mock.calls[0]?.[0]?.message ?? "";
    expect(isFixCommit(message)).toBe(true);
  });

  it("does nothing when no patch was verified", async () => {
    const { deps, getBranchTip, createCommitOnBranch } = makeDeps();

    const outcome = await applyFixes(
      target,
      { branch: "main", files: [], patchCount: 0 },
      deps,
    );

    expect(outcome.status).toBe("skipped");
    expect(getBranchTip).not.toHaveBeenCalled();
    expect(createCommitOnBranch).not.toHaveBeenCalled();
  });

  it("degrades without committing when the branch moved during the review", async () => {
    const { deps, createCommitOnBranch } = makeDeps({
      getBranchTip: async () => "movedon1",
    });

    const outcome = await applyFixes(
      target,
      { branch: "main", files, patchCount: 1 },
      deps,
    );

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "the branch moved during the review",
    });
    expect(createCommitOnBranch).not.toHaveBeenCalled();
  });

  it("degrades when the token cannot write to the branch", async () => {
    const { deps, entries } = makeDeps({
      createCommitOnBranch: async () => {
        throw httpError(403);
      },
    });

    const outcome = await applyFixes(
      target,
      { branch: "main", files, patchCount: 1 },
      deps,
    );

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "the workflow token cannot write to this branch",
    });
    expect(entries.map((entry) => entry["event"])).toContain(
      "review.fixes.degraded",
    );
  });

  it("degrades when the ref update is not a fast-forward", async () => {
    const { deps } = makeDeps({
      createCommitOnBranch: async () => {
        throw httpError(422);
      },
    });

    const outcome = await applyFixes(
      target,
      { branch: "main", files, patchCount: 1 },
      deps,
    );

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "the branch moved during the review",
    });
  });

  it("rethrows a failure that is not the token's fault", async () => {
    const { deps } = makeDeps({
      createCommitOnBranch: async () => {
        throw httpError(500);
      },
    });

    await expect(
      applyFixes(target, { branch: "main", files, patchCount: 1 }, deps),
    ).rejects.toThrow("HTTP 500");
  });
});
