import type { ReviewContext } from "@pr-review/ai";
import type {
  ChangedFile,
  CreateCheckRunInput,
  GithubInstallationClient,
  PullRequestDetails,
  PullRequestRef,
} from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import type { ReviewRunResult } from "@pr-review/reviewer";
import type { ReviewFinding, ReviewJob } from "@pr-review/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerHandler, type WorkerSqsEvent } from "./handler.js";

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
  baseSha: "0000000000000000000000000000000000000000",
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

// Candidate-finding fixtures (formerly the placeholder sample
// findings): they exercise the deterministic validation chain exactly
// as real agent output does.

/** Survives validation when the PR adds line 42 of this file. */
const validLineFinding: ReviewFinding = {
  file: "src/sample/session-service.ts",
  line: 42,
  category: "correctness",
  severity: "high",
  title: "Assignment instead of comparison in admin check",
  explanation:
    "The if condition assigns true to user.isAdmin instead of comparing, so every user passes the check.",
  suggestedFix: "Use === instead of = in the condition.",
  confidence: 0.9,
};

/** Survives validation when the PR contains this file; no annotation. */
const fileLevelFinding: ReviewFinding = {
  file: "src/sample/session-service.ts",
  category: "correctness",
  severity: "medium",
  title: "Session expiry errors are swallowed",
  explanation:
    "Expiry failures are caught and ignored, so expired sessions keep working.",
  confidence: 0.8,
};

/** Dropped: references a file that is not part of the pull request. */
const wrongFileFinding: ReviewFinding = {
  file: "src/not-part-of-this-pr.ts",
  line: 7,
  category: "correctness",
  severity: "high",
  title: "Error swallowed in catch block",
  explanation: "The catch block returns an empty result instead of failing.",
  confidence: 0.95,
};

/** Dropped: confidence is below the 0.70 threshold. */
const lowConfidenceFinding: ReviewFinding = {
  file: "src/sample/session-service.ts",
  line: 43,
  category: "correctness",
  severity: "low",
  title: "Possible off-by-one in session TTL comparison",
  explanation: "The TTL comparison may exclude the final second.",
  confidence: 0.4,
};

/** Dropped by Zod: confidence is outside the allowed 0..1 range. */
const schemaInvalidFinding: unknown = {
  file: "src/sample/session-service.ts",
  category: "correctness",
  severity: "high",
  title: "Malformed candidate with out-of-range confidence",
  explanation: "This candidate must be rejected by schema validation.",
  confidence: 1.5,
};

function makeClient() {
  return {
    getPullRequest: vi.fn(async (_ref: PullRequestRef) => pullRequest),
    listChangedFiles: vi.fn(async (_ref: PullRequestRef) => changedFiles),
    getDiff: vi.fn(async (_ref: PullRequestRef) => diff),
    getFileContents: vi.fn(async () => "export const sessions = [];\n"),
    searchCode: vi.fn(async () => [
      { path: "src/sessions.ts", name: "sessions.ts" },
    ]),
    createCheckRun: vi.fn(async (_input: CreateCheckRunInput) => ({ id: 987 })),
  } satisfies GithubInstallationClient;
}

function makeHandler(reviewResult: ReviewRunResult = { candidates: [], agentFailures: [] }) {
  const client = makeClient();
  const createInstallationClient = vi.fn(() => client);
  const runReview = vi.fn(
    async (_client: GithubInstallationClient, _context: ReviewContext) =>
      reviewResult,
  );
  // Passthrough synthesiser by default: tests that exercise synthesis
  // script it per test.
  const synthesise = vi.fn(async (candidates: readonly unknown[]) => ({
    findings: candidates,
    usage: { inputTokens: 0, outputTokens: 0 },
  }));
  const { logger, entries } = createCapturingLogger();
  const handler = createWorkerHandler({
    createInstallationClient,
    runReview,
    synthesise,
    logger,
  });
  return {
    handler,
    client,
    createInstallationClient,
    runReview,
    synthesise,
    entries,
  };
}

/** A PR whose diff adds lines 42-44 of the candidates' file. */
const changedFilesWithAddedLines: ChangedFile[] = [
  {
    filename: validLineFinding.file,
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
];

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

  it("runs the review against the loaded context with the installation client", async () => {
    const { handler, client, runReview } = makeHandler();

    await handler(sqsEvent(validRecord));

    expect(runReview).toHaveBeenCalledExactlyOnceWith(client, {
      owner: job.owner,
      repo: job.repo,
      pullRequest,
      changedFiles,
      diff,
    });
  });

  it("publishes a clean check run when no candidate survives validation", async () => {
    // None of these candidates reference the PR's actual changed file,
    // so the deterministic chain drops them all.
    const { handler, client } = makeHandler({
      candidates: [schemaInvalidFinding, wrongFileFinding, lowConfidenceFinding],
      agentFailures: [],
    });

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

  it("publishes surviving agent findings through validation and rendering", async () => {
    const { handler, client } = makeHandler({
      candidates: [
        schemaInvalidFinding,
        wrongFileFinding,
        lowConfidenceFinding,
        validLineFinding,
        fileLevelFinding,
      ],
      agentFailures: [],
    });
    // A PR that actually changes the file the candidates reference,
    // with added lines 42-44 on the new side.
    client.listChangedFiles.mockResolvedValueOnce(changedFilesWithAddedLines);

    await handler(sqsEvent(validRecord));

    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    const input = client.createCheckRun.mock.calls[0]?.[0];
    // Only the valid line-anchored and file-level candidates survive:
    // the wrong-file, low-confidence, and schema-invalid ones are
    // dropped by the deterministic chain.
    expect(input?.conclusion).toBe("neutral");
    expect(input?.output.title).toBe("2 findings");
    expect(input?.output.summary).toContain(validLineFinding.title);
    expect(input?.output.summary).toContain(fileLevelFinding.title);
    expect(input?.output.annotations).toEqual([
      expect.objectContaining({
        path: validLineFinding.file,
        start_line: validLineFinding.line,
        end_line: validLineFinding.line,
        annotation_level: "failure",
        title: validLineFinding.title,
      }),
    ]);
  });

  it("reports a batch item failure when the review (all three agents) fails, without publishing", async () => {
    const { handler, client, runReview } = makeHandler();
    runReview.mockRejectedValueOnce(
      new Error(
        "every review agent failed — correctness: invalid JSON; " +
          "security: model unavailable; architecture: turn cap exceeded",
      ),
    );

    const response = await handler(sqsEvent(validRecord));

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-valid" },
    ]);
    expect(client.createCheckRun).not.toHaveBeenCalled();
  });

  it("still publishes when some agents failed but candidates survived", async () => {
    const { handler, client } = makeHandler({
      candidates: [],
      agentFailures: [{ agent: "security", error: "model unavailable" }],
    });

    const response = await handler(sqsEvent(validRecord));

    expect(response.batchItemFailures).toEqual([]);
    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    // The failed agent is surfaced in the check run without the error
    // detail leaking to GitHub; the agent.failed log event is emitted
    // by the agent runtime at failure time (see agent-runtime.test.ts).
    const input = client.createCheckRun.mock.calls[0]?.[0];
    expect(input?.output.summary).toMatch(
      /security review.*(did not complete|failed)/is,
    );
    expect(input?.output.summary).not.toContain("model unavailable");
  });

  it("with one agent failed, publishes the other two lenses' findings and notes the failed lens", async () => {
    const architectureFinding: ReviewFinding = {
      file: validLineFinding.file,
      line: 43,
      category: "architecture",
      severity: "medium",
      title: "Session logic reimplemented outside the session service",
      explanation:
        "The session lookup duplicates the existing session-service helper instead of reusing it.",
      confidence: 0.8,
    };
    const { handler, client } = makeHandler({
      candidates: [validLineFinding, architectureFinding],
      agentFailures: [{ agent: "security", error: "model unavailable" }],
    });
    client.listChangedFiles.mockResolvedValueOnce(changedFilesWithAddedLines);

    const response = await handler(sqsEvent(validRecord));

    expect(response.batchItemFailures).toEqual([]);
    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    const input = client.createCheckRun.mock.calls[0]?.[0];
    expect(input?.output.title).toBe("2 findings");
    expect(input?.output.summary).toContain(validLineFinding.title);
    expect(input?.output.summary).toContain(architectureFinding.title);
    expect(input?.output.summary).toMatch(
      /security review.*(did not complete|failed)/is,
    );
  });

  it("pipes the raw candidates through the synthesiser and publishes the synthesised findings", async () => {
    const combinedFinding: ReviewFinding = {
      ...validLineFinding,
      title: "Combined: admin gate always passes",
    };
    const { handler, client, synthesise } = makeHandler({
      // Two lenses reporting the same underlying issue.
      candidates: [
        validLineFinding,
        { ...validLineFinding, category: "security" as const },
      ],
      agentFailures: [],
    });
    synthesise.mockResolvedValueOnce({
      findings: [combinedFinding],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    client.listChangedFiles.mockResolvedValueOnce(changedFilesWithAddedLines);

    await handler(sqsEvent(validRecord));

    expect(synthesise).toHaveBeenCalledExactlyOnceWith([
      validLineFinding,
      { ...validLineFinding, category: "security" },
    ]);
    const input = client.createCheckRun.mock.calls[0]?.[0];
    // One combined finding, not the two raw duplicates.
    expect(input?.output.title).toBe("1 finding");
    expect(input?.output.summary).toContain(combinedFinding.title);
    expect(input?.output.summary).not.toContain(validLineFinding.title);
  });

  it("still drops a synthesised finding pointing at a non-PR file via the deterministic chain", async () => {
    // KEY: the synthesiser is not the final authority. Even when it
    // returns a finding for a file outside the PR, validateFindings
    // drops it before anything reaches GitHub.
    const { handler, client, synthesise } = makeHandler({
      candidates: [validLineFinding],
      agentFailures: [],
    });
    synthesise.mockResolvedValueOnce({
      findings: [wrongFileFinding],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    client.listChangedFiles.mockResolvedValueOnce(changedFilesWithAddedLines);

    await handler(sqsEvent(validRecord));

    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    const input = client.createCheckRun.mock.calls[0]?.[0];
    expect(input?.conclusion).toBe("success");
    expect(input?.output.title).toMatch(/no issues found/i);
    expect(input?.output.summary).not.toContain(wrongFileFinding.title);
  });

  it("falls back to the validated raw findings and logs synthesis.failed when synthesis fails", async () => {
    const { handler, client, synthesise, entries } = makeHandler({
      candidates: [validLineFinding],
      agentFailures: [],
    });
    synthesise.mockRejectedValueOnce(new Error("anthropic unavailable"));
    client.listChangedFiles.mockResolvedValueOnce(changedFilesWithAddedLines);

    const response = await handler(sqsEvent(validRecord));

    // The review does not die: the raw finding is validated and
    // published, and the failure is a log event, not a batch failure.
    expect(response.batchItemFailures).toEqual([]);
    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    const input = client.createCheckRun.mock.calls[0]?.[0];
    expect(input?.output.title).toBe("1 finding");
    expect(input?.output.summary).toContain(validLineFinding.title);
    const failed = entries.find((entry) => entry.event === "synthesis.failed");
    expect(failed).toMatchObject({
      level: "error",
      repository: "octo-org/example-service",
      pullRequestNumber: 42,
      headSha: job.headSha,
      error: "anthropic unavailable",
      errorName: "Error",
    });
    expect(typeof failed?.["durationMs"]).toBe("number");
  });

  it("skips the synthesis call entirely when the agents produced no candidates", async () => {
    const { handler, client, synthesise } = makeHandler({
      candidates: [],
      agentFailures: [],
    });

    await handler(sqsEvent(validRecord));

    // Nothing to refine: no synthesis model call for a clean review.
    expect(synthesise).not.toHaveBeenCalled();
    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    expect(client.createCheckRun.mock.calls[0]?.[0]?.conclusion).toBe("success");
  });

  it("reports a batch item failure for an unparseable message body and publishes nothing", async () => {
    const { handler, client, createInstallationClient, entries } = makeHandler();

    const response = await handler(
      sqsEvent({ messageId: "msg-bad-json", body: "not-json{" }),
    );

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-bad-json" },
    ]);
    expect(createInstallationClient).not.toHaveBeenCalled();
    expect(client.createCheckRun).not.toHaveBeenCalled();
    expect(entries.map((entry) => entry.event)).toContain("review.failed");
  });

  it("reports a batch item failure for a body that fails schema validation and publishes nothing", async () => {
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

  it("reports a batch item failure when loading the PR fails, without running the review", async () => {
    const { handler, client, runReview } = makeHandler();
    client.getDiff.mockRejectedValueOnce(new Error("github unavailable"));

    const response = await handler(sqsEvent(validRecord));

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-valid" },
    ]);
    expect(runReview).not.toHaveBeenCalled();
    expect(client.createCheckRun).not.toHaveBeenCalled();
  });

  it("reports a batch item failure when publishing the check run fails", async () => {
    const { handler, client } = makeHandler();
    client.createCheckRun.mockRejectedValueOnce(new Error("checks API down"));

    const response = await handler(sqsEvent(validRecord));

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "msg-valid" },
    ]);
  });
});

describe("review lifecycle events (spec §26)", () => {
  // The correlation fields every event of one review carries, so an
  // operator can answer "what happened to the review for PR 42?" from
  // CloudWatch logs alone.
  const correlation = {
    repository: "octo-org/example-service",
    pullRequestNumber: 42,
    headSha: job.headSha,
  };

  it("emits the success-path sequence with the correlation fields on every event", async () => {
    const { handler, entries } = makeHandler();

    await handler(sqsEvent(validRecord));

    expect(entries.map((entry) => entry.event)).toEqual([
      "review.started",
      "review.loaded",
      "synthesis.skipped", // clean review: no candidates to refine
      "findings.validated",
      "review.published",
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject(correlation);
    }
  });

  it("emits review.published with the final finding count", async () => {
    const { handler, client, entries } = makeHandler({
      candidates: [validLineFinding, fileLevelFinding],
      agentFailures: [],
    });
    client.listChangedFiles.mockResolvedValueOnce(changedFilesWithAddedLines);

    await handler(sqsEvent(validRecord));

    expect(entries.at(-1)).toMatchObject({
      level: "info",
      event: "review.published",
      ...correlation,
      findingCount: 2,
    });
  });

  it("emits synthesis.started/completed with duration and the synthesiser's token usage", async () => {
    const { handler, client, synthesise, entries } = makeHandler({
      candidates: [validLineFinding, fileLevelFinding],
      agentFailures: [],
    });
    synthesise.mockResolvedValueOnce({
      findings: [validLineFinding],
      usage: { inputTokens: 512, outputTokens: 64 },
    });
    client.listChangedFiles.mockResolvedValueOnce(changedFilesWithAddedLines);

    await handler(sqsEvent(validRecord));

    expect(
      entries.find((entry) => entry.event === "synthesis.started"),
    ).toMatchObject({ level: "info", ...correlation, candidateCount: 2 });
    const completed = entries.find(
      (entry) => entry.event === "synthesis.completed",
    );
    expect(completed).toMatchObject({
      level: "info",
      ...correlation,
      candidateCount: 2,
      refinedCount: 1,
      inputTokens: 512,
      outputTokens: 64,
    });
    expect(typeof completed?.["durationMs"]).toBe("number");
  });

  it("on the partial-failure path still ends in review.published without duplicating agent.failed", async () => {
    const { handler, entries } = makeHandler({
      candidates: [],
      agentFailures: [{ agent: "security", error: "model unavailable" }],
    });

    await handler(sqsEvent(validRecord));

    const eventNames = entries.map((entry) => entry.event);
    // agent.started/completed/failed are emitted once, by the agent
    // runtime, at the moment they happen (agent-runtime.test.ts); the
    // worker never re-emits them, so each agent appears exactly once
    // per review in the logs.
    expect(eventNames).not.toContain("agent.failed");
    expect(eventNames.at(-1)).toBe("review.published");
  });

  it("emits review.failed with correlation fields and diagnostic context when the review dies after parsing", async () => {
    const { handler, runReview, entries } = makeHandler();
    runReview.mockRejectedValueOnce(
      new Error("every review agent failed — correctness: invalid JSON"),
    );

    await handler(sqsEvent(validRecord));

    const failed = entries.at(-1);
    expect(failed).toMatchObject({
      level: "error",
      event: "review.failed",
      ...correlation,
      messageId: "msg-valid",
      errorName: "Error",
    });
    expect(failed?.["error"]).toMatch(/every review agent failed/);
    expect(entries.map((entry) => entry.event)).not.toContain(
      "review.published",
    );
  });

  it("emits review.failed with the message id when the job body cannot be parsed", async () => {
    const { handler, entries } = makeHandler();

    await handler(sqsEvent({ messageId: "msg-bad-json", body: "not-json{" }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "error",
      event: "review.failed",
      messageId: "msg-bad-json",
      errorName: "Error",
    });
    expect(entries[0]?.["error"]).toMatch(/not valid JSON/i);
  });

  it("emits review.failed instead of review.published when publishing the check run fails", async () => {
    const { handler, client, entries } = makeHandler();
    client.createCheckRun.mockRejectedValueOnce(new Error("checks API down"));

    await handler(sqsEvent(validRecord));

    const eventNames = entries.map((entry) => entry.event);
    expect(eventNames).toContain("findings.validated");
    expect(eventNames).not.toContain("review.published");
    expect(entries.at(-1)).toMatchObject({
      level: "error",
      event: "review.failed",
      ...correlation,
      error: "checks API down",
    });
  });
});
