/** The token auth path end to end, over an injected Octokit stub. */
import { describe, expect, it, vi } from "vitest";

import type { OctokitLike } from "./app.js";
import { CHECK_RUN_NAME, type PullRequestRef } from "./client.js";
import { createTokenClient } from "./token.js";

const ref: PullRequestRef = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
};

const headSha = "6dcb09b5b57875f334f61aebed695e2e4193db5e";

/** Stand-in for the workflow token Actions hands the step. */
const token = "ghs_workflowtoken";

/** A pulls.get response with the mapped fields plus extras the client must ignore. */
const pullResponse = {
  number: 42,
  title: "Add rate limiting to the sessions endpoint",
  body: "Adds a token bucket to the sessions endpoint.",
  state: "open",
  user: { login: "octocat" },
  base: { ref: "main", sha: "0000000000000000000000000000000000000000" },
  head: { ref: "feature/rate-limit", sha: headSha },
  html_url: "https://github.com/octo-org/example-service/pull/42",
  draft: false,
};

const diffText = [
  "diff --git a/src/sessions.ts b/src/sessions.ts",
  "--- a/src/sessions.ts",
  "+++ b/src/sessions.ts",
  "@@ -1 +1,2 @@",
  " export const sessions = [];",
  "+export const rateLimited = true;",
  "",
].join("\n");

function makeFile(index: number) {
  return {
    filename: `src/file-${index}.ts`,
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: `@@ -1 +1,2 @@ file ${index}`,
    sha: "abc123",
    blob_url: "https://example.invalid/blob",
  };
}

/** A repos.getContent file response for src/sessions.ts at some ref. */
const fileContentsResponse = {
  type: "file",
  encoding: "base64",
  name: "sessions.ts",
  path: "src/sessions.ts",
  content: Buffer.from("export const sessions = [];\n", "utf8").toString(
    "base64",
  ),
  sha: "def456",
};

/** A search.code response with one in-repo match and one foreign match. */
const codeSearchResponse = {
  total_count: 2,
  incomplete_results: false,
  items: [
    {
      name: "sessions.ts",
      path: "src/sessions.ts",
      sha: "abc",
      repository: { full_name: "octo-org/example-service" },
      text_matches: [
        { object_type: "FileContent", property: "content", fragment: "  createSession(id);\n" },
        { property: "path", fragment: "src/sessions.ts" },
      ],
    },
    {
      name: "other.ts",
      path: "src/other.ts",
      sha: "def",
      repository: { full_name: "someone-else/other-repo" },
    },
  ],
};

/** A one-item search response; `extra` supplies the item's text_matches. */
function oneItemSearchResponse(extra: Record<string, unknown>) {
  return {
    total_count: 1,
    incomplete_results: false,
    items: [
      {
        name: "a.ts",
        path: "src/a.ts",
        repository: { full_name: "octo-org/example-service" },
        ...extra,
      },
    ],
  };
}

/** A repos.listCommits response, with fields the client must ignore. */
const commitListResponse = [
  { sha: "aaa111", commit: { message: "Rate limit sessions" } },
  { sha: "bbb222", commit: { message: "Document the sessions endpoint" } },
];

/** A repos.getCommit response; only filenames are mapped. */
const commitResponse = {
  sha: "aaa111",
  stats: { total: 4 },
  files: [
    { filename: "src/sessions.ts", additions: 3, deletions: 1 },
    { filename: "docs/sessions.md", additions: 1, deletions: 0 },
  ],
};

interface StubOptions {
  filePages?: unknown[][];
  pullData?: unknown;
  diffData?: unknown;
  contentData?: unknown;
  searchData?: unknown;
  reviewData?: unknown;
  reviewCommentPages?: unknown[][];
  commitListData?: unknown;
  commitData?: unknown;
}

function makeOctokit(options: StubOptions = {}) {
  const filePages = options.filePages ?? [[makeFile(1), makeFile(2)]];
  const commentPages = options.reviewCommentPages ?? [[]];
  const octokit = {
    rest: {
      pulls: {
        get: vi.fn(
          async (params: {
            owner: string;
            repo: string;
            pull_number: number;
            mediaType?: { format: "diff" };
          }) =>
            params.mediaType?.format === "diff"
              ? { data: options.diffData ?? diffText }
              : { data: options.pullData ?? pullResponse },
        ),
        listFiles: vi.fn(
          async (params: {
            owner: string;
            repo: string;
            pull_number: number;
            per_page: number;
            page: number;
          }) => ({ data: filePages[params.page - 1] ?? [] }),
        ),
        listReviewComments: vi.fn(
          async (
            params: Parameters<
              OctokitLike["rest"]["pulls"]["listReviewComments"]
            >[0],
          ) => ({ data: commentPages[params.page - 1] ?? [] }),
        ),
        createReview: vi.fn(
          async (
            _params: Parameters<OctokitLike["rest"]["pulls"]["createReview"]>[0],
          ) => ({ data: options.reviewData ?? { id: 654 } }),
        ),
      },
      repos: {
        getContent: vi.fn(
          async (_params: { owner: string; repo: string; path: string; ref: string }) => ({
            data: options.contentData ?? fileContentsResponse,
          }),
        ),
        listCommits: vi.fn(
          async (_params: Parameters<OctokitLike["rest"]["repos"]["listCommits"]>[0]) => ({
            data: options.commitListData ?? commitListResponse,
          }),
        ),
        getCommit: vi.fn(
          async (_params: Parameters<OctokitLike["rest"]["repos"]["getCommit"]>[0]) => ({
            data: options.commitData ?? commitResponse,
          }),
        ),
      },
      search: {
        code: vi.fn(async (_params: { q: string; per_page: number }) => ({
          data: options.searchData ?? codeSearchResponse,
        })),
      },
      checks: {
        create: vi.fn(
          async (
            _params: Parameters<OctokitLike["rest"]["checks"]["create"]>[0],
          ) => ({ data: { id: 987 } }),
        ),
      },
    },
  } satisfies OctokitLike;
  return octokit;
}

function makeClient(options: StubOptions = {}) {
  const octokit = makeOctokit(options);
  const createOctokit = vi.fn(() => octokit);
  const client = createTokenClient({ token, createOctokit });
  return { octokit, createOctokit, client };
}

describe("createTokenClient", () => {
  it("creates an Octokit authenticated with the supplied token", () => {
    const { createOctokit } = makeClient();

    expect(createOctokit).toHaveBeenCalledTimes(1);
    expect(createOctokit).toHaveBeenCalledWith(token);
  });

  it("builds an independent client per token", () => {
    const octokit = makeOctokit();
    const createOctokit = vi.fn(() => octokit);

    const first = createTokenClient({ token, createOctokit });
    const second = createTokenClient({ token: "ghs_othertoken", createOctokit });

    expect(first).not.toBe(second);
    expect(createOctokit).toHaveBeenCalledTimes(2);
    expect(createOctokit).toHaveBeenNthCalledWith(1, token);
    expect(createOctokit).toHaveBeenNthCalledWith(2, "ghs_othertoken");
  });

  it("builds a real Octokit client when no factory is injected", () => {
    const client = createTokenClient({ token });

    expect(typeof client.getPullRequest).toBe("function");
    expect(typeof client.listChangedFiles).toBe("function");
    expect(typeof client.getDiff).toBe("function");
    expect(typeof client.createCheckRun).toBe("function");
  });
});

describe("getPullRequest", () => {
  it("loads the PR and maps title, description, and metadata", async () => {
    const { octokit, client } = makeClient();

    const pullRequest = await client.getPullRequest(ref);

    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "example-service",
      pull_number: 42,
    });
    expect(pullRequest).toEqual({
      number: 42,
      title: "Add rate limiting to the sessions endpoint",
      body: "Adds a token bucket to the sessions endpoint.",
      author: "octocat",
      baseRef: "main",
      baseSha: "0000000000000000000000000000000000000000",
      headRef: "feature/rate-limit",
      headSha,
    });
  });

  it("maps a null description and missing author", async () => {
    const { client } = makeClient({
      pullData: { ...pullResponse, body: null, user: null },
    });

    const pullRequest = await client.getPullRequest(ref);

    expect(pullRequest.body).toBeNull();
    expect(pullRequest.author).toBeNull();
  });

  it("rejects a malformed PR response", async () => {
    const { client } = makeClient({
      pullData: { title: "missing everything else" },
    });

    await expect(client.getPullRequest(ref)).rejects.toThrow();
  });
});

describe("listChangedFiles", () => {
  it("maps changed files and drops fields we do not consume", async () => {
    const { octokit, client } = makeClient();

    const files = await client.listChangedFiles(ref);

    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "octo-org",
        repo: "example-service",
        pull_number: 42,
      }),
    );
    expect(files).toEqual([
      {
        filename: "src/file-1.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1,2 @@ file 1",
      },
      {
        filename: "src/file-2.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1,2 @@ file 2",
      },
    ]);
  });

  it("paginates until a short page is returned", async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => makeFile(i));
    const pageTwo = [makeFile(100), makeFile(101)];
    const { octokit, client } = makeClient({
      filePages: [pageOne, pageTwo],
    });

    const files = await client.listChangedFiles(ref);

    expect(files).toHaveLength(102);
    expect(files[101]?.filename).toBe("src/file-101.ts");
    expect(octokit.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
    expect(octokit.rest.pulls.listFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ per_page: 100, page: 1 }),
    );
    expect(octokit.rest.pulls.listFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ per_page: 100, page: 2 }),
    );
  });

  it("omits the patch for files without one (e.g. binary files)", async () => {
    const { patch: _patch, ...binaryFile } = makeFile(1);
    const { client } = makeClient({ filePages: [[binaryFile]] });

    const files = await client.listChangedFiles(ref);

    expect(files).toHaveLength(1);
    expect(files[0]?.patch).toBeUndefined();
  });

  it("rejects a malformed file listing", async () => {
    const { client } = makeClient({
      filePages: [[{ filename: 42 }]],
    });

    await expect(client.listChangedFiles(ref)).rejects.toThrow();
  });
});

describe("getDiff", () => {
  it("requests the diff media type and returns the raw diff", async () => {
    const { octokit, client } = makeClient();

    const diff = await client.getDiff(ref);

    expect(diff).toBe(diffText);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "example-service",
      pull_number: 42,
      mediaType: { format: "diff" },
    });
  });

  it("rejects when the API does not return a textual diff", async () => {
    const { client } = makeClient({ diffData: { not: "a diff" } });

    await expect(client.getDiff(ref)).rejects.toThrow();
  });
});

describe("getFileContents", () => {
  it("requests the path at the given ref and decodes the base64 content", async () => {
    const { octokit, client } = makeClient();

    const contents = await client.getFileContents({
      owner: "octo-org",
      repo: "example-service",
      path: "src/sessions.ts",
      ref: headSha,
    });

    expect(contents).toBe("export const sessions = [];\n");
    expect(octokit.rest.repos.getContent).toHaveBeenCalledExactlyOnceWith({
      owner: "octo-org",
      repo: "example-service",
      path: "src/sessions.ts",
      ref: headSha,
    });
  });

  it("rejects when the path is a directory (array response)", async () => {
    const { client } = makeClient({
      contentData: [fileContentsResponse],
    });

    await expect(
      client.getFileContents({
        owner: "octo-org",
        repo: "example-service",
        path: "src",
        ref: headSha,
      }),
    ).rejects.toThrow(/directory/i);
  });

  it("rejects when the entry is not a plain file (e.g. a submodule)", async () => {
    const { client } = makeClient({
      contentData: { ...fileContentsResponse, type: "submodule" },
    });

    await expect(
      client.getFileContents({
        owner: "octo-org",
        repo: "example-service",
        path: "vendored",
        ref: headSha,
      }),
    ).rejects.toThrow();
  });

  it("rejects content with an unsupported encoding (e.g. too-large files)", async () => {
    const { client } = makeClient({
      contentData: { ...fileContentsResponse, encoding: "none", content: "" },
    });

    await expect(
      client.getFileContents({
        owner: "octo-org",
        repo: "example-service",
        path: "big.bin",
        ref: headSha,
      }),
    ).rejects.toThrow(/encoding/i);
  });
});

describe("listCommitShas", () => {
  it("asks for the path's commits and returns their SHAs alone", async () => {
    const { octokit, client } = makeClient();

    const shas = await client.listCommitShas({
      owner: "octo-org",
      repo: "example-service",
      path: "src/sessions.ts",
      limit: 10,
    });

    expect(octokit.rest.repos.listCommits).toHaveBeenCalledExactlyOnceWith({
      owner: "octo-org",
      repo: "example-service",
      path: "src/sessions.ts",
      per_page: 10,
    });
    expect(shas).toEqual(["aaa111", "bbb222"]);
  });

  it("returns nothing for a path with no history", async () => {
    const { client } = makeClient({ commitListData: [] });

    await expect(
      client.listCommitShas({
        owner: "octo-org",
        repo: "example-service",
        path: "src/new.ts",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});

describe("listCommitFiles", () => {
  it("returns one commit's filenames", async () => {
    const { octokit, client } = makeClient();

    const files = await client.listCommitFiles({
      owner: "octo-org",
      repo: "example-service",
      sha: "aaa111",
    });

    expect(octokit.rest.repos.getCommit).toHaveBeenCalledExactlyOnceWith({
      owner: "octo-org",
      repo: "example-service",
      ref: "aaa111",
    });
    expect(files).toEqual(["src/sessions.ts", "docs/sessions.md"]);
  });

  it("returns nothing for a commit that carries no files array", async () => {
    const { client } = makeClient({ commitData: { sha: "aaa111" } });

    await expect(
      client.listCommitFiles({
        owner: "octo-org",
        repo: "example-service",
        sha: "aaa111",
      }),
    ).resolves.toEqual([]);
  });
});

describe("searchCode", () => {
  it("scopes the query to the repository with a repo: qualifier", async () => {
    const { octokit, client } = makeClient();

    await client.searchCode({
      owner: "octo-org",
      repo: "example-service",
      query: "createSession",
    });

    expect(octokit.rest.search.code).toHaveBeenCalledExactlyOnceWith({
      q: "createSession repo:octo-org/example-service",
      per_page: 20,
      mediaType: { format: "text-match" },
    });
  });

  it("returns matches from the target repository only, with their content fragments", async () => {
    const { client } = makeClient();

    const result = await client.searchCode({
      owner: "octo-org",
      repo: "example-service",
      query: "createSession",
    });

    // The path-property fragment is dropped: it only repeats the path.
    expect(result).toEqual({
      matches: [
        {
          path: "src/sessions.ts",
          name: "sessions.ts",
          snippets: ["  createSession(id);\n"],
        },
      ],
      totalCount: 2,
      incompleteResults: false,
    });
  });

  it("reports an incomplete result set rather than hiding it", async () => {
    const { client } = makeClient({
      searchData: { total_count: 900, incomplete_results: true, items: [] },
    });

    const result = await client.searchCode({
      owner: "octo-org",
      repo: "example-service",
      query: "createSession",
    });

    expect(result).toEqual({
      matches: [],
      totalCount: 900,
      incompleteResults: true,
    });
  });

  it.each([
    ["no text_matches at all", {}, []],
    ["a text match with no fragment", { text_matches: [{ property: "content" }] }, []],
    [
      "only a path-property match",
      { text_matches: [{ property: "path", fragment: "src/a.ts" }] },
      [],
    ],
    [
      "content fragments, kept verbatim and in order",
      {
        text_matches: [
          { property: "content", fragment: "  second()\n" },
          { property: "content", fragment: "first()" },
        ],
      },
      ["  second()\n", "first()"],
    ],
  ])("maps %s", async (_label, extra, snippets) => {
    const { client } = makeClient({ searchData: oneItemSearchResponse(extra) });

    const result = await client.searchCode({
      owner: "octo-org",
      repo: "example-service",
      query: "createSession",
    });

    expect(result.matches[0]?.snippets).toEqual(snippets);
  });

  it.each([
    ["items is not an array", { items: "not-an-array" }],
    ["the totals are missing", { items: [] }],
    ["text_matches is not an array", oneItemSearchResponse({ text_matches: "nope" })],
  ])("rejects a malformed search response: %s", async (_label, searchData) => {
    const { client } = makeClient({ searchData });

    await expect(
      client.searchCode({
        owner: "octo-org",
        repo: "example-service",
        query: "createSession",
      }),
    ).rejects.toThrow();
  });
});

describe("createCheckRun", () => {
  it('publishes a completed check run named exactly "AI PR Review" against the head SHA', async () => {
    const { octokit, client } = makeClient();

    const checkRun = await client.createCheckRun({
      owner: "octo-org",
      repo: "example-service",
      headSha,
      conclusion: "neutral",
      output: {
        title: "AI review pending",
        summary: "The automated review pipeline is connected.",
      },
    });

    expect(CHECK_RUN_NAME).toBe("AI PR Review");
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(octokit.rest.checks.create).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "example-service",
      name: "AI PR Review",
      head_sha: headSha,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: "AI review pending",
        summary: "The automated review pipeline is connected.",
      },
    });
    expect(checkRun).toEqual({ id: 987 });
  });

  it("passes inline annotations through to the checks API", async () => {
    const { octokit, client } = makeClient();
    const annotations = [
      {
        path: "src/auth/session.ts",
        start_line: 84,
        end_line: 84,
        annotation_level: "failure" as const,
        message: "Missing tenant validation.",
        title: "Missing tenant validation",
      },
    ];

    await client.createCheckRun({
      owner: "octo-org",
      repo: "example-service",
      headSha,
      conclusion: "neutral",
      output: { title: "1 finding", summary: "One security finding.", annotations },
    });

    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        output: {
          title: "1 finding",
          summary: "One security finding.",
          annotations,
        },
      }),
    );
  });

  it("omits the annotations field when the list is empty", async () => {
    const { octokit, client } = makeClient();

    await client.createCheckRun({
      owner: "octo-org",
      repo: "example-service",
      headSha,
      conclusion: "success",
      output: { title: "No issues found", summary: "Clean.", annotations: [] },
    });

    const params = octokit.rest.checks.create.mock.calls[0]?.[0];
    expect(params?.output).not.toHaveProperty("annotations");
  });

  it("rejects when the check run cannot be created", async () => {
    const { octokit, client } = makeClient();
    octokit.rest.checks.create.mockRejectedValueOnce(
      new Error("Resource not accessible by integration"),
    );

    await expect(
      client.createCheckRun({
        owner: "octo-org",
        repo: "example-service",
        headSha,
        conclusion: "neutral",
        output: { title: "t", summary: "s" },
      }),
    ).rejects.toThrow("Resource not accessible by integration");
  });
});

/** One inline comment as GitHub returns it, with fields the client ignores. */
function makeComment(index: number) {
  return {
    id: 1000 + index,
    body: `<!-- pr-review-finding: src/file-${index}.ts|title -->`,
    path: `src/file-${index}.ts`,
    line: index,
    user: { login: "github-actions[bot]" },
  };
}

describe("listReviewComments", () => {
  it("keeps only the comment body, and drops the fields we do not consume", async () => {
    const { octokit, client } = makeClient({
      reviewCommentPages: [[makeComment(1), makeComment(2)]],
    });

    const comments = await client.listReviewComments(ref);

    expect(octokit.rest.pulls.listReviewComments).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "octo-org",
        repo: "example-service",
        pull_number: 42,
      }),
    );
    expect(comments).toEqual([
      { body: "<!-- pr-review-finding: src/file-1.ts|title -->" },
      { body: "<!-- pr-review-finding: src/file-2.ts|title -->" },
    ]);
  });

  it("paginates until a short page is returned", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      makeComment(index),
    );
    const pageTwo = [makeComment(100), makeComment(101)];
    const { octokit, client } = makeClient({
      reviewCommentPages: [pageOne, pageTwo],
    });

    const comments = await client.listReviewComments(ref);

    expect(comments).toHaveLength(102);
    expect(comments[101]?.body).toContain("src/file-101.ts");
    expect(octokit.rest.pulls.listReviewComments).toHaveBeenCalledTimes(2);
    expect(octokit.rest.pulls.listReviewComments).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ per_page: 100, page: 1 }),
    );
    expect(octokit.rest.pulls.listReviewComments).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ per_page: 100, page: 2 }),
    );
  });

  it("stops after one page when the pull request has no comments", async () => {
    const { octokit, client } = makeClient();

    await expect(client.listReviewComments(ref)).resolves.toEqual([]);
    expect(octokit.rest.pulls.listReviewComments).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed comment listing", async () => {
    const { client } = makeClient({ reviewCommentPages: [[{ body: 42 }]] });

    await expect(client.listReviewComments(ref)).rejects.toThrow();
  });
});

describe("createReview", () => {
  const comments = [
    { path: "src/sessions.ts", line: 2, body: "Session token logged." },
    { path: "src/auth.ts", line: 84, body: "Missing tenant validation." },
  ];

  it("posts one advisory review on the commit, every comment on the new side", async () => {
    const { octokit, client } = makeClient();

    const review = await client.createReview({
      owner: "octo-org",
      repo: "example-service",
      pullRequestNumber: 42,
      commitSha: headSha,
      body: "2 findings",
      comments,
    });

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "example-service",
      pull_number: 42,
      commit_id: headSha,
      body: "2 findings",
      event: "COMMENT",
      comments: [
        {
          path: "src/sessions.ts",
          line: 2,
          side: "RIGHT",
          body: "Session token logged.",
        },
        {
          path: "src/auth.ts",
          line: 84,
          side: "RIGHT",
          body: "Missing tenant validation.",
        },
      ],
    });
    expect(review).toEqual({ id: 654 });
  });

  it("sends an empty comment list rather than omitting the field", async () => {
    const { octokit, client } = makeClient();

    await client.createReview({
      owner: "octo-org",
      repo: "example-service",
      pullRequestNumber: 42,
      commitSha: headSha,
      body: "No issues found",
      comments: [],
    });

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [] }),
    );
  });

  // GitHub rejects the whole review, not the offending comment.
  it("rejects when one comment's line falls outside the diff", async () => {
    const { octokit, client } = makeClient();
    octokit.rest.pulls.createReview.mockRejectedValueOnce(
      new Error("pull_request_review_thread.line must be part of the diff"),
    );

    await expect(
      client.createReview({
        owner: "octo-org",
        repo: "example-service",
        pullRequestNumber: 42,
        commitSha: headSha,
        body: "1 finding",
        comments,
      }),
    ).rejects.toThrow("must be part of the diff");
  });

  it("rejects a malformed review response", async () => {
    const { client } = makeClient({ reviewData: { id: "654" } });

    await expect(
      client.createReview({
        owner: "octo-org",
        repo: "example-service",
        pullRequestNumber: 42,
        commitSha: headSha,
        body: "1 finding",
        comments,
      }),
    ).rejects.toThrow();
  });
});
