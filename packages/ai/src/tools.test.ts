import type {
  ChangedFile,
  GithubInstallationClient,
  PullRequestDetails,
} from "@pr-review/github";
import { describe, expect, it, vi } from "vitest";

import { dispatchReviewTool, reviewTools, type ReviewToolScope } from "./tools.js";

const scope: ReviewToolScope = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  baseSha: "0000000000000000000000000000000000000000",
};

const pullRequest: PullRequestDetails = {
  number: 42,
  title: "Add rate limiting",
  body: "Adds a token bucket.",
  author: "octocat",
  baseRef: "main",
  baseSha: scope.baseSha,
  headRef: "feature/rate-limit",
  headSha: scope.headSha,
};

const changedFiles: ChangedFile[] = [
  {
    filename: "src/sessions.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1,2 @@",
  },
];

function makeGithub() {
  return {
    getPullRequest: vi.fn(async () => pullRequest),
    listChangedFiles: vi.fn(async () => changedFiles),
    getDiff: vi.fn(async () => "diff --git a/src/sessions.ts b/src/sessions.ts\n"),
    getFileContents: vi.fn(async () => "export const sessions = [];\n"),
    searchCode: vi.fn(async () => [{ path: "src/sessions.ts", name: "sessions.ts" }]),
    createCheckRun: vi.fn(async () => ({ id: 987 })),
  } satisfies GithubInstallationClient;
}

describe("reviewTools", () => {
  it("exposes exactly the six read-only tools from the spec", () => {
    expect(reviewTools.map((tool) => tool.name).sort()).toEqual([
      "get_base_file",
      "get_diff",
      "get_file",
      "get_pull_request",
      "list_changed_files",
      "search_repository",
    ]);
  });

  it("declares a strict JSON-schema input for every tool", () => {
    for (const tool of reviewTools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("dispatchReviewTool", () => {
  it("dispatches get_pull_request to the client and returns PR details as JSON", async () => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "get_pull_request", {});

    expect(github.getPullRequest).toHaveBeenCalledExactlyOnceWith({
      owner: scope.owner,
      repo: scope.repo,
      pullRequestNumber: scope.pullRequestNumber,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.content)).toMatchObject({ title: "Add rate limiting" });
    }
  });

  it("dispatches list_changed_files and returns the file list without patches", async () => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "list_changed_files", {});

    expect(github.listChangedFiles).toHaveBeenCalledExactlyOnceWith({
      owner: scope.owner,
      repo: scope.repo,
      pullRequestNumber: scope.pullRequestNumber,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.content)).toEqual([
        { filename: "src/sessions.ts", status: "modified", additions: 2, deletions: 1 },
      ]);
    }
  });

  it("dispatches get_diff to the client", async () => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "get_diff", {});

    expect(github.getDiff).toHaveBeenCalledExactlyOnceWith({
      owner: scope.owner,
      repo: scope.repo,
      pullRequestNumber: scope.pullRequestNumber,
    });
    expect(result).toEqual({
      ok: true,
      content: "diff --git a/src/sessions.ts b/src/sessions.ts\n",
    });
  });

  it("dispatches get_file to getFileContents at the head SHA", async () => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "get_file", {
      path: "src/sessions.ts",
    });

    expect(github.getFileContents).toHaveBeenCalledExactlyOnceWith({
      owner: scope.owner,
      repo: scope.repo,
      path: "src/sessions.ts",
      ref: scope.headSha,
    });
    expect(result).toEqual({ ok: true, content: "export const sessions = [];\n" });
  });

  it("dispatches get_base_file to getFileContents at the base SHA", async () => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "get_base_file", {
      path: "src/sessions.ts",
    });

    expect(github.getFileContents).toHaveBeenCalledExactlyOnceWith({
      owner: scope.owner,
      repo: scope.repo,
      path: "src/sessions.ts",
      ref: scope.baseSha,
    });
    expect(result.ok).toBe(true);
  });

  it("dispatches search_repository to searchCode scoped to the repository", async () => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "search_repository", {
      query: "createSession",
    });

    expect(github.searchCode).toHaveBeenCalledExactlyOnceWith({
      owner: scope.owner,
      repo: scope.repo,
      query: "createSession",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.content)).toEqual([
        { path: "src/sessions.ts", name: "sessions.ts" },
      ]);
    }
  });

  it("rejects an unknown tool name without touching the client", async () => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "approve_pull_request", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unknown tool/i);
    }
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it.each([
    ["missing path", {}],
    ["non-string path", { path: 42 }],
    ["non-object input", "src/sessions.ts"],
    ["empty path", { path: "" }],
    ["absolute path", { path: "/etc/passwd" }],
    ["path traversal", { path: "../../secrets/config.yml" }],
    ["extra properties", { path: "src/sessions.ts", ref: "some-other-sha" }],
  ])("rejects get_file with %s as an error result, client untouched", async (_label, input) => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "get_file", input);

    expect(result.ok).toBe(false);
    expect(github.getFileContents).not.toHaveBeenCalled();
  });

  it.each([
    ["a repo: qualifier", { query: "secrets repo:someone-else/private" }],
    ["an org: qualifier", { query: "org:someone-else token" }],
    ["a user: qualifier", { query: "user:someone-else token" }],
    ["an empty query", { query: "" }],
    ["an over-long query", { query: "x".repeat(300) }],
    ["a non-string query", { query: { nested: true } }],
  ])("rejects search_repository with %s, client untouched", async (_label, input) => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "search_repository", input);

    expect(result.ok).toBe(false);
    expect(github.searchCode).not.toHaveBeenCalled();
  });

  it("rejects unexpected properties on a no-input tool", async () => {
    const github = makeGithub();

    const result = await dispatchReviewTool(github, scope, "get_diff", {
      pull_number: 7,
    });

    expect(result.ok).toBe(false);
    expect(github.getDiff).not.toHaveBeenCalled();
  });

  it("returns a github client failure as an error result instead of throwing", async () => {
    const github = makeGithub();
    github.getFileContents.mockRejectedValueOnce(new Error("404 not found"));

    const result = await dispatchReviewTool(github, scope, "get_file", {
      path: "src/missing.ts",
    });

    expect(result).toEqual({ ok: false, error: "404 not found" });
  });

  it("truncates oversized tool results", async () => {
    const github = makeGithub();
    github.getDiff.mockResolvedValueOnce("x".repeat(200_000));

    const result = await dispatchReviewTool(github, scope, "get_diff", {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.length).toBeLessThan(200_000);
      expect(result.content).toMatch(/truncated/i);
    }
  });
});
