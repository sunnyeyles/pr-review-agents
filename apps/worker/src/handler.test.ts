import type {
  ChangedFile,
  CreateCheckRunInput,
  GithubInstallationClient,
  PullRequestDetails,
  PullRequestRef,
} from "@pr-review/github";
import type { ReviewJob } from "@pr-review/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerHandler, type WorkerSqsEvent } from "./handler.js";
import {
  sampleFileLevelFinding,
  sampleValidLineFinding,
} from "./sample-findings.js";

const job: ReviewJob = {
  installationId: 12345678,
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

const pullRequest: PullRequestDetails = {
  number: 42,
  title: "Add rate limiting to the sessions endpoint",
  body: "Adds a token bucket to the sessions endpoint.",
  state: "open",
  author: "octocat",
  baseRef: "main",
  headRef: "feature/rate-limit",
  headSha: job.headSha,
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

const diff = "diff --git a/src/sessions.ts b/src/sessions.ts\n";

function makeClient() {
  return {
    getPullRequest: vi.fn(async (_ref: PullRequestRef) => pullRequest),
    listChangedFiles: vi.fn(async (_ref: PullRequestRef) => changedFiles),
    getDiff: vi.fn(async (_ref: PullRequestRef) => diff),
    createCheckRun: vi.fn(async (_input: CreateCheckRunInput) => ({ id: 987 })),
  } satisfies GithubInstallationClient;
}

function makeHandler() {
  const client = makeClient();
  const createInstallationClient = vi.fn(() => client);
  const handler = createWorkerHandler({ createInstallationClient });
  return { handler, client, createInstallationClient };
}

function sqsEvent(...records: { messageId: string; body: string }[]): WorkerSqsEvent {
  return { Records: records };
}

const validRecord = { messageId: "msg-valid", body: JSON.stringify(job) };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWorkerHandler", () => {
  it("processes a valid job without reporting batch item failures", async () => {
    const { handler } = makeHandler();

    const response = await handler(sqsEvent(validRecord));

    expect(response).toEqual({ batchItemFailures: [] });
  });

  it("authenticates as the installation from the job", async () => {
    const { handler, createInstallationClient } = makeHandler();

    await handler(sqsEvent(validRecord));

    expect(createInstallationClient).toHaveBeenCalledTimes(1);
    expect(createInstallationClient).toHaveBeenCalledWith(job.installationId);
  });

  it("loads the PR, its changed files, and its diff", async () => {
    const { handler, client } = makeHandler();

    await handler(sqsEvent(validRecord));

    const ref = {
      owner: job.owner,
      repo: job.repo,
      pullRequestNumber: job.pullRequestNumber,
    };
    expect(client.getPullRequest).toHaveBeenCalledExactlyOnceWith(ref);
    expect(client.listChangedFiles).toHaveBeenCalledExactlyOnceWith(ref);
    expect(client.getDiff).toHaveBeenCalledExactlyOnceWith(ref);
  });

  it("publishes exactly one clean check run when no sample finding survives validation", async () => {
    // The default fixture PR does not contain the files the placeholder
    // sample findings reference, so the whole list is dropped by the
    // deterministic validation chain and the check run reports a clean
    // result.
    const { handler, client } = makeHandler();

    await handler(sqsEvent(validRecord));

    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    const input = client.createCheckRun.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      owner: job.owner,
      repo: job.repo,
      headSha: job.headSha,
      conclusion: "success",
    });
    expect(input?.output.title).toMatch(/no issues found/i);
    expect(input?.output.annotations).toBeUndefined();
  });

  it("renders surviving sample findings in the check run when the PR contains their file", async () => {
    const { handler, client } = makeHandler();
    // A PR that actually changes the file the samples reference, with a
    // patch whose added lines are 42, 43, and 44 on the new side.
    client.listChangedFiles.mockResolvedValueOnce([
      {
        filename: sampleValidLineFinding.file,
        status: "modified",
        additions: 3,
        deletions: 0,
        patch: [
          "@@ -40,2 +40,5 @@",
          " context line 40",
          " context line 41",
          "+added line 42",
          "+added line 43",
          "+added line 44",
        ].join("\n"),
      },
    ]);

    await handler(sqsEvent(validRecord));

    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    const input = client.createCheckRun.mock.calls[0]?.[0];
    // Of the samples, only the valid line-anchored finding and the
    // file-level finding survive: the wrong-file, low-confidence, and
    // schema-invalid samples are dropped by the chain.
    expect(input?.conclusion).toBe("neutral");
    expect(input?.output.title).toBe("2 findings");
    expect(input?.output.summary).toContain(sampleValidLineFinding.title);
    expect(input?.output.summary).toContain(sampleFileLevelFinding.title);
    expect(input?.output.summary).not.toMatch(/pipeline is connected/i);
    expect(input?.output.annotations).toEqual([
      expect.objectContaining({
        path: sampleValidLineFinding.file,
        start_line: sampleValidLineFinding.line,
        end_line: sampleValidLineFinding.line,
        annotation_level: "failure",
        title: sampleValidLineFinding.title,
      }),
    ]);
  });

  it("reports a batch item failure for an unparseable message body and publishes nothing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, client, createInstallationClient } = makeHandler();

    const response = await handler(
      sqsEvent({ messageId: "msg-bad-json", body: "not-json{" }),
    );

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-bad-json" },
    ]);
    expect(createInstallationClient).not.toHaveBeenCalled();
    expect(client.createCheckRun).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("reports a batch item failure for a body that fails schema validation and publishes nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, client, createInstallationClient } = makeHandler();

    const invalidJob = { ...job, headSha: "not-a-sha" };
    const response = await handler(
      sqsEvent({ messageId: "msg-bad-schema", body: JSON.stringify(invalidJob) }),
    );

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-bad-schema" },
    ]);
    expect(createInstallationClient).not.toHaveBeenCalled();
    expect(client.createCheckRun).not.toHaveBeenCalled();
  });

  it("reports only the invalid message ids in a mixed batch and still processes the valid job", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, client } = makeHandler();

    const response = await handler(
      sqsEvent(
        { messageId: "msg-bad-json", body: "not-json{" },
        validRecord,
        { messageId: "msg-bad-schema", body: JSON.stringify({ nope: true }) },
      ),
    );

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-bad-json" },
      { itemIdentifier: "msg-bad-schema" },
    ]);
    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
  });

  it("reports a batch item failure when loading the PR fails, without publishing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, client } = makeHandler();
    client.getDiff.mockRejectedValueOnce(new Error("github unavailable"));

    const response = await handler(sqsEvent(validRecord));

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-valid" },
    ]);
    expect(client.createCheckRun).not.toHaveBeenCalled();
  });

  it("reports a batch item failure when publishing the check run fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, client } = makeHandler();
    client.createCheckRun.mockRejectedValueOnce(new Error("checks API down"));

    const response = await handler(sqsEvent(validRecord));

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-valid" },
    ]);
  });
});
