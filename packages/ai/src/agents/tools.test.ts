import type {
  ChangedFile,
  GithubInstallationClient,
  PullRequestDetails,
} from "@pr-review/github";
import type { Tool, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { createReviewTools, type ReviewToolScope } from "./tools.js";

const headSha = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
const baseSha = "0000000000000000000000000000000000000000";

const pullRequest: PullRequestDetails = {
  number: 42,
  title: "Add rate limiting",
  body: "Adds a token bucket.",
  author: "octocat",
  baseRef: "main",
  baseSha,
  headRef: "feature/rate-limit",
  headSha,
};

const changedFiles: ChangedFile[] = [
  {
    filename: "src/sessions.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -1 +1,2 @@",
  },
  {
    filename: "assets/logo.png",
    status: "added",
    additions: 0,
    deletions: 0,
  },
];

const diff = "diff --git a/src/sessions.ts b/src/sessions.ts\n";

const scope: ReviewToolScope = {
  owner: "octo-org",
  repo: "example-service",
  pullRequest,
  changedFiles,
  diff,
};

function makeGithub() {
  return {
    getPullRequest: vi.fn(async () => pullRequest),
    listChangedFiles: vi.fn(async () => changedFiles),
    getDiff: vi.fn(async () => diff),
    getFileContents: vi.fn(async () => "export const sessions = [];\n"),
    searchCode: vi.fn(async () => [{ path: "src/sessions.ts", name: "sessions.ts" }]),
    listReviewComments: vi.fn(async () => []),
    createCheckRun: vi.fn(async () => ({ id: 987 })),
    createReview: vi.fn(async () => ({ id: 654 })),
  } satisfies GithubInstallationClient;
}

/** The SDK stores the Zod schema we passed, so tests can parse against it. */
function schemaOf(tools: ToolSet, name: string): z.ZodType {
  return tools[name]?.inputSchema as unknown as z.ZodType;
}

/** The SDK supplies these to `execute`; nothing under test reads them. */
const executeOptions = {
  toolCallId: "call-1",
  messages: [],
} as unknown as Parameters<NonNullable<Tool["execute"]>>[1];

function run(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (execute === undefined) {
    throw new Error(`no executable tool named ${name}`);
  }
  return Promise.resolve(execute(input, executeOptions));
}

describe("createReviewTools", () => {
  it("exposes exactly the six read-only tools from the spec", () => {
    expect(Object.keys(createReviewTools(makeGithub(), scope)).sort()).toEqual([
      "get_base_file",
      "get_diff",
      "get_file",
      "get_pull_request",
      "list_changed_files",
      "search_repository",
    ]);
  });

  it("describes every tool it exposes", () => {
    for (const tool of Object.values(createReviewTools(makeGithub(), scope))) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  /** Descriptions live on the Zod schemas, where a new field is easy to forget. */
  it.each([
    ["get_file", "path"],
    ["get_base_file", "path"],
    ["search_repository", "query"],
    ["get_diff", "path"],
  ])("describes %s's %s parameter", (name, parameter) => {
    const tools = createReviewTools(makeGithub(), scope);
    const shape = (
      schemaOf(tools, name) as unknown as {
        shape: Record<string, { description?: string }>;
      }
    ).shape;
    expect(Object.keys(shape)).toEqual([parameter]);
    expect(shape[parameter]?.description).toBeTruthy();
  });

  it("offers no tool that could write to the repository", () => {
    const tools = createReviewTools(makeGithub(), scope);
    expect(tools["approve_pull_request"]).toBeUndefined();
    expect(tools["create_review"]).toBeUndefined();
  });
});

describe("review tool execution", () => {
  it("answers get_pull_request from the review context, not GitHub", async () => {
    const github = makeGithub();
    const result = await run(
      createReviewTools(github, scope),
      "get_pull_request",
      {},
    );

    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(JSON.parse(result as string)).toEqual(pullRequest);
  });

  it("lists changed files from the review context, without their patches", async () => {
    const github = makeGithub();
    const result = await run(
      createReviewTools(github, scope),
      "list_changed_files",
      {},
    );

    expect(github.listChangedFiles).not.toHaveBeenCalled();
    expect(JSON.parse(result as string)).toEqual([
      {
        filename: "src/sessions.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
      {
        filename: "assets/logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it("returns the loaded diff verbatim when get_diff names no path", async () => {
    const github = makeGithub();
    const result = await run(createReviewTools(github, scope), "get_diff", {});

    expect(github.getDiff).not.toHaveBeenCalled();
    expect(result).toBe(diff);
  });

  it("returns one file's patch when get_diff names a path", async () => {
    const result = await run(createReviewTools(makeGithub(), scope), "get_diff", {
      path: "src/sessions.ts",
    });

    expect(result).toBe("@@ -1 +1,2 @@");
  });

  it("rejects get_diff for a path the pull request did not change", async () => {
    await expect(
      run(createReviewTools(makeGithub(), scope), "get_diff", {
        path: "src/elsewhere.ts",
      }),
    ).rejects.toThrow("not a file this pull request changed");
  });

  it("rejects get_diff for a changed file that carries no patch", async () => {
    await expect(
      run(createReviewTools(makeGithub(), scope), "get_diff", {
        path: "assets/logo.png",
      }),
    ).rejects.toThrow("no patch");
  });

  it("reads get_file at the head commit", async () => {
    const github = makeGithub();
    await run(createReviewTools(github, scope), "get_file", {
      path: "src/sessions.ts",
    });

    expect(github.getFileContents).toHaveBeenCalledWith({
      owner: scope.owner,
      repo: scope.repo,
      path: "src/sessions.ts",
      ref: headSha,
    });
  });

  it("reads get_base_file at the base commit", async () => {
    const github = makeGithub();
    await run(createReviewTools(github, scope), "get_base_file", {
      path: "src/sessions.ts",
    });

    expect(github.getFileContents).toHaveBeenCalledWith({
      owner: scope.owner,
      repo: scope.repo,
      path: "src/sessions.ts",
      ref: baseSha,
    });
  });

  it("scopes search_repository to the pull request's own repository", async () => {
    const github = makeGithub();
    const result = await run(
      createReviewTools(github, scope),
      "search_repository",
      { query: "createSession" },
    );

    expect(github.searchCode).toHaveBeenCalledWith({
      owner: scope.owner,
      repo: scope.repo,
      query: "createSession",
    });
    expect(JSON.parse(result as string)).toEqual([
      { path: "src/sessions.ts", name: "sessions.ts" },
    ]);
  });

  it("truncates oversized tool results", async () => {
    const huge = { ...scope, diff: "x".repeat(200_000) };

    const result = (await run(
      createReviewTools(makeGithub(), huge),
      "get_diff",
      {},
    )) as string;

    expect(result.length).toBeLessThan(200_000);
    expect(result).toMatch(/truncated/i);
  });

  /** The SDK turns a rejected execute into a tool-error the model reads. */
  it("lets a github client failure reject rather than swallowing it", async () => {
    const github = makeGithub();
    github.getFileContents.mockRejectedValueOnce(new Error("404 not found"));

    await expect(
      run(createReviewTools(github, scope), "get_file", {
        path: "src/missing.ts",
      }),
    ).rejects.toThrow("404 not found");
  });
});

/** The SDK validates against these before `execute` ever runs. */
describe("review tool input schemas", () => {
  it.each([
    ["missing path", {}],
    ["non-string path", { path: 42 }],
    ["non-object input", "src/sessions.ts"],
    ["empty path", { path: "" }],
    ["absolute path", { path: "/etc/passwd" }],
    ["path traversal", { path: "../../secrets/config.yml" }],
    ["extra properties", { path: "src/sessions.ts", ref: "some-other-sha" }],
  ])("rejects get_file with %s", (_label, input) => {
    const tools = createReviewTools(makeGithub(), scope);
    expect(schemaOf(tools, "get_file").safeParse(input).success).toBe(false);
  });

  it.each([
    ["a repo: qualifier", { query: "secrets repo:someone-else/private" }],
    ["an org: qualifier", { query: "org:someone-else token" }],
    ["a user: qualifier", { query: "user:someone-else token" }],
    ["an empty query", { query: "" }],
    ["an over-long query", { query: "x".repeat(300) }],
    ["a non-string query", { query: { nested: true } }],
  ])("rejects search_repository with %s", (_label, input) => {
    const tools = createReviewTools(makeGithub(), scope);
    expect(schemaOf(tools, "search_repository").safeParse(input).success).toBe(
      false,
    );
  });

  it("rejects unexpected properties on a no-input tool", () => {
    const tools = createReviewTools(makeGithub(), scope);
    expect(
      schemaOf(tools, "get_diff").safeParse({ pull_number: 7 }).success,
    ).toBe(false);
  });

  it("accepts a plain repository-relative path", () => {
    const tools = createReviewTools(makeGithub(), scope);
    expect(
      schemaOf(tools, "get_file").safeParse({ path: "src/index.ts" }).success,
    ).toBe(true);
  });
});
