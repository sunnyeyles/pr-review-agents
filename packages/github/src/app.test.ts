import { describe, expect, it, vi } from "vitest";

import { createGithubApp, type OctokitLike } from "./app.js";
import { CHECK_RUN_NAME, type PullRequestRef } from "./client.js";

const ref: PullRequestRef = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
};

const headSha = "6dcb09b5b57875f334f61aebed695e2e4193db5e";

/**
 * A pulls.get response trimmed to the fields we map (plus realistic
 * extras the client must ignore).
 */
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
    },
    {
      name: "other.ts",
      path: "src/other.ts",
      sha: "def",
      repository: { full_name: "someone-else/other-repo" },
    },
  ],
};

interface StubOptions {
  filePages?: unknown[][];
  pullData?: unknown;
  diffData?: unknown;
  contentData?: unknown;
  searchData?: unknown;
}

function makeOctokit(options: StubOptions = {}) {
  const filePages = options.filePages ?? [[makeFile(1), makeFile(2)]];
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
      },
      repos: {
        getContent: vi.fn(
          async (_params: { owner: string; repo: string; path: string; ref: string }) => ({
            data: options.contentData ?? fileContentsResponse,
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

function makeApp(options: StubOptions = {}) {
  const octokit = makeOctokit(options);
  const createOctokit = vi.fn(() => octokit);
  const createInstallationClient = createGithubApp({
    appId: "123456",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    createOctokit,
  });
  return { octokit, createOctokit, createInstallationClient };
}

describe("createGithubApp", () => {
  it("creates an Octokit authenticated for the requested installation", () => {
    const { createOctokit, createInstallationClient } = makeApp();

    createInstallationClient(12345678);

    expect(createOctokit).toHaveBeenCalledTimes(1);
    expect(createOctokit).toHaveBeenCalledWith(12345678);
  });

  it("reuses the client for repeated requests for the same installation", () => {
    const { createOctokit, createInstallationClient } = makeApp();

    const first = createInstallationClient(12345678);
    const second = createInstallationClient(12345678);
    createInstallationClient(87654321);

    expect(first).toBe(second);
    expect(createOctokit).toHaveBeenCalledTimes(2);
    expect(createOctokit).toHaveBeenNthCalledWith(2, 87654321);
  });

  it("builds a real Octokit client when no factory is injected", () => {
    const createInstallationClient = createGithubApp({
      appId: "123456",
      privateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    });

    const client = createInstallationClient(12345678);

    expect(typeof client.getPullRequest).toBe("function");
    expect(typeof client.listChangedFiles).toBe("function");
    expect(typeof client.getDiff).toBe("function");
    expect(typeof client.createCheckRun).toBe("function");
  });
});

describe("getPullRequest", () => {
  it("loads the PR and maps title, description, and metadata", async () => {
    const { octokit, createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);

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
      state: "open",
      author: "octocat",
      baseRef: "main",
      baseSha: "0000000000000000000000000000000000000000",
      headRef: "feature/rate-limit",
      headSha,
    });
  });

  it("maps a null description and missing author", async () => {
    const { createInstallationClient } = makeApp({
      pullData: { ...pullResponse, body: null, user: null },
    });
    const client = createInstallationClient(12345678);

    const pullRequest = await client.getPullRequest(ref);

    expect(pullRequest.body).toBeNull();
    expect(pullRequest.author).toBeNull();
  });

  it("rejects a malformed PR response", async () => {
    const { createInstallationClient } = makeApp({
      pullData: { title: "missing everything else" },
    });
    const client = createInstallationClient(12345678);

    await expect(client.getPullRequest(ref)).rejects.toThrow();
  });
});

describe("listChangedFiles", () => {
  it("maps changed files and drops fields we do not consume", async () => {
    const { octokit, createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);

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
    const { octokit, createInstallationClient } = makeApp({
      filePages: [pageOne, pageTwo],
    });
    const client = createInstallationClient(12345678);

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
    const { createInstallationClient } = makeApp({ filePages: [[binaryFile]] });
    const client = createInstallationClient(12345678);

    const files = await client.listChangedFiles(ref);

    expect(files).toHaveLength(1);
    expect(files[0]?.patch).toBeUndefined();
  });

  it("rejects a malformed file listing", async () => {
    const { createInstallationClient } = makeApp({
      filePages: [[{ filename: 42 }]],
    });
    const client = createInstallationClient(12345678);

    await expect(client.listChangedFiles(ref)).rejects.toThrow();
  });
});

describe("getDiff", () => {
  it("requests the diff media type and returns the raw diff", async () => {
    const { octokit, createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);

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
    const { createInstallationClient } = makeApp({ diffData: { not: "a diff" } });
    const client = createInstallationClient(12345678);

    await expect(client.getDiff(ref)).rejects.toThrow();
  });
});

describe("getFileContents", () => {
  it("requests the path at the given ref and decodes the base64 content", async () => {
    const { octokit, createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);

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
    const { createInstallationClient } = makeApp({
      contentData: [fileContentsResponse],
    });
    const client = createInstallationClient(12345678);

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
    const { createInstallationClient } = makeApp({
      contentData: { ...fileContentsResponse, type: "submodule" },
    });
    const client = createInstallationClient(12345678);

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
    const { createInstallationClient } = makeApp({
      contentData: { ...fileContentsResponse, encoding: "none", content: "" },
    });
    const client = createInstallationClient(12345678);

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

describe("searchCode", () => {
  it("scopes the query to the repository with a repo: qualifier", async () => {
    const { octokit, createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);

    await client.searchCode({
      owner: "octo-org",
      repo: "example-service",
      query: "createSession",
    });

    expect(octokit.rest.search.code).toHaveBeenCalledExactlyOnceWith({
      q: "createSession repo:octo-org/example-service",
      per_page: 20,
    });
  });

  it("returns matches from the target repository only", async () => {
    const { createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);

    const matches = await client.searchCode({
      owner: "octo-org",
      repo: "example-service",
      query: "createSession",
    });

    expect(matches).toEqual([{ path: "src/sessions.ts", name: "sessions.ts" }]);
  });

  it("rejects a malformed search response", async () => {
    const { createInstallationClient } = makeApp({
      searchData: { items: "not-an-array" },
    });
    const client = createInstallationClient(12345678);

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
    const { octokit, createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);

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
    const { octokit, createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);
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
    const { octokit, createInstallationClient } = makeApp();
    const client = createInstallationClient(12345678);

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
    const { octokit, createInstallationClient } = makeApp();
    octokit.rest.checks.create.mockRejectedValueOnce(
      new Error("Resource not accessible by integration"),
    );
    const client = createInstallationClient(12345678);

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
