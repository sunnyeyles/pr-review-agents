import type {
  ChangedFile,
  GithubInstallationClient,
  PullRequestDetails,
} from "@pr-review/github";
import type { Tool, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { createReviewTools, type ReviewToolScope } from "./tools.js";

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
    searchCode: vi.fn(async () => ({
      matches: [
        {
          path: "src/sessions.ts",
          name: "sessions.ts",
          snippets: ["export function createSession() {"],
        },
      ],
      totalCount: 1,
      incompleteResults: false,
    })),
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
  it("exposes exactly the seven read-only tools from the spec", () => {
    expect(Object.keys(createReviewTools(makeGithub(), scope)).sort()).toEqual([
      "find_importers",
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
    ["find_importers", "path"],
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
  it("dispatches get_pull_request to the client and returns PR details as JSON", async () => {
    const github = makeGithub();
    const result = await run(
      createReviewTools(github, scope),
      "get_pull_request",
      {},
    );

    expect(github.getPullRequest).toHaveBeenCalledWith({
      owner: scope.owner,
      repo: scope.repo,
      pullRequestNumber: scope.pullRequestNumber,
    });
    expect(JSON.parse(result as string)).toEqual(pullRequest);
  });

  it("lists changed files without their patches", async () => {
    const github = makeGithub();
    const result = await run(
      createReviewTools(github, scope),
      "list_changed_files",
      {},
    );

    expect(JSON.parse(result as string)).toEqual([
      {
        filename: "src/sessions.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
    ]);
  });

  it("returns the diff verbatim", async () => {
    const github = makeGithub();
    const result = await run(createReviewTools(github, scope), "get_diff", {});

    expect(github.getDiff).toHaveBeenCalled();
    expect(result).toBe("diff --git a/src/sessions.ts b/src/sessions.ts\n");
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
      ref: scope.headSha,
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
      ref: scope.baseSha,
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
    expect(JSON.parse(result as string)).toEqual({
      totalCount: 1,
      incompleteResults: false,
      matches: [
        {
          path: "src/sessions.ts",
          name: "sessions.ts",
          snippets: ["export function createSession() {"],
        },
      ],
    });
  });

  it("caps snippets so an oversized search result is still valid JSON", async () => {
    const github = makeGithub();
    github.searchCode.mockResolvedValueOnce({
      matches: Array.from({ length: 20 }, (_unused, index) => ({
        path: `src/file-${index}.ts`,
        name: `file-${index}.ts`,
        snippets: Array.from({ length: 5 }, () => "x".repeat(5_000)),
      })),
      totalCount: 843,
      incompleteResults: true,
    });

    const result = (await run(createReviewTools(github, scope), "search_repository", {
      query: "createSession",
    })) as string;

    // truncate() would slice the JSON mid-string; the caps must land first.
    expect(result).not.toMatch(/truncated/i);
    const payload = JSON.parse(result);
    expect(payload.totalCount).toBe(843);
    expect(payload.incompleteResults).toBe(true);
    for (const match of payload.matches) {
      expect(match.snippets).toHaveLength(2);
      expect(match.snippets[0].length).toBeLessThanOrEqual(401);
    }
  });

  it("runs find_importers with the file's name stem, quoted, minus itself", async () => {
    const github = makeGithub();

    const result = (await run(createReviewTools(github, scope), "find_importers", {
      path: "src/sessions.ts",
    })) as string;

    expect(github.searchCode).toHaveBeenCalledExactlyOnceWith({
      owner: scope.owner,
      repo: scope.repo,
      query: '"sessions"',
    });
    const payload = JSON.parse(result);
    expect(payload.searchedFor).toBe("sessions");
    // The stub's only match is the subject file itself.
    expect(payload.matches).toEqual([]);
  });

  it.each([
    ["src/session/index.ts", "session"],
    ["pkg/auth/__init__.py", "auth"],
    ["crates/parser/src/mod.rs", "parser"],
    ["cmd/server/main.go", "server"],
    ["types/session.d.ts", "session.d"],
  ])("derives a distinctive stem for %s", async (path, stem) => {
    const github = makeGithub();

    await run(createReviewTools(github, scope), "find_importers", { path });

    expect(github.searchCode).toHaveBeenCalledExactlyOnceWith({
      owner: scope.owner,
      repo: scope.repo,
      query: `"${stem}"`,
    });
  });

  it.each([
    ["every segment is generic", "src/index.ts"],
    ["the stem would carry a qualifier", "org:someone.ts"],
    ["the stem would carry a space", "a b/index.ts"],
  ])("rejects find_importers when %s, client untouched", async (_label, path) => {
    const github = makeGithub();

    await expect(
      run(createReviewTools(github, scope), "find_importers", { path }),
    ).rejects.toThrow(/no distinctive name/i);
    expect(github.searchCode).not.toHaveBeenCalled();
  });

  it.each([
    ["path traversal", { path: "../secrets/config.yml" }],
    ["absolute path", { path: "/etc/passwd" }],
    ["extra properties", { path: "src/sessions.ts", ref: "deadbeef" }],
  ])("rejects find_importers input with %s", (_label, input) => {
    const tools = createReviewTools(makeGithub(), scope);
    expect(schemaOf(tools, "find_importers").safeParse(input).success).toBe(false);
  });

  it("truncates oversized tool results", async () => {
    const github = makeGithub();
    github.getDiff.mockResolvedValueOnce("x".repeat(200_000));

    const result = (await run(
      createReviewTools(github, scope),
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
