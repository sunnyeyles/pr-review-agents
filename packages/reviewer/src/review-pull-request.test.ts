import {
  emptyTokenUsage,
  type AgentDefinition,
  type ReviewContext,
} from "@pr-review/ai";
import type {
  ChangedFile,
  CreateCheckRunInput,
  CreateReviewInput,
  ExistingReviewComment,
  GithubInstallationClient,
  PullRequestDetails,
  PullRequestRef,
  ReviewThread,
  WriteFileRequest,
} from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import {
  reviewMemorySchema,
  type MemoryShape,
  type ReviewFinding,
} from "@pr-review/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryStore } from "./memory.js";
import type { PublishReview } from "./publish-review.js";
import { findingMarker } from "./render-review.js";
import {
  skippedSynthesis,
  type ReviewPipelineResult,
} from "./review-pipeline.js";
import { reviewPullRequest } from "./review-pull-request.js";
import type { ReviewTarget } from "./review-target.js";

const target: ReviewTarget = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

const pullRequest: PullRequestDetails = {
  number: 42,
  title: "Add rate limiting to the sessions endpoint",
  body: "Adds a token bucket to the sessions endpoint.",
  author: "octocat",
  baseRef: "main",
  baseSha: "0000000000000000000000000000000000000000",
  headRef: "feature/rate-limit",
  headSha: target.headSha,
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

const finding: ReviewFinding = {
  file: "src/sessions.ts",
  line: 2,
  category: "correctness",
  severity: "high",
  title: "Assignment instead of comparison in admin check",
  explanation:
    "The if condition assigns true to user.isAdmin instead of comparing, so every user passes the check.",
  confidence: 0.9,
};

/** An Octokit-shaped error: the status is what the code reacts to. */
function permissionError(status: number): Error {
  return Object.assign(new Error("boom"), { status });
}

function makeClient() {
  return {
    getPullRequest: vi.fn(async (_ref: PullRequestRef) => pullRequest),
    listChangedFiles: vi.fn(async (_ref: PullRequestRef) => changedFiles),
    getDiff: vi.fn(async (_ref: PullRequestRef) => diff),
    getFileContents: vi.fn(async () => "export const sessions = [];\n"),
    searchCode: vi.fn(async () => ({
      matches: [],
      totalCount: 0,
      incompleteResults: false,
    })),
    listCommitShas: vi.fn(async () => []),
    listCommitFiles: vi.fn(async () => []),
    listReviewComments: vi.fn(async (): Promise<ExistingReviewComment[]> => []),
    listReviewThreads: vi.fn(async (): Promise<ReviewThread[]> => []),
    createCheckRun: vi.fn(async (_input: CreateCheckRunInput) => ({ id: 987 })),
    createReview: vi.fn(async (_input: CreateReviewInput) => ({ id: 654 })),
    writeFileOnBranch: vi.fn(async (_request: WriteFileRequest) => {}),
  } satisfies GithubInstallationClient;
}

function reviewResult(
  overrides: Partial<ReviewPipelineResult> = {},
): ReviewPipelineResult {
  const candidates = overrides.candidates ?? [];
  return {
    candidates,
    agentFailures: [],
    synthesis:
      candidates.length === 0
        ? skippedSynthesis()
        : {
            outcome: "completed",
            candidates,
            usage: emptyTokenUsage(),
            durationMs: 0,
          },
    findings: candidates as ReviewFinding[],
    ...overrides,
  };
}

/** An agent definition; `paths` is what the gate reads. */
function makeAgent(
  category: string,
  paths?: readonly string[],
): AgentDefinition {
  return {
    category,
    role: `${category} reviewer`,
    focus: `Review only for ${category} problems.`,
    ...(paths === undefined ? {} : { paths }),
  };
}

interface DepsOptions {
  agents?: readonly AgentDefinition[];
  publishReview?: PublishReview;
  memoryStore?: MemoryStore;
  now?: () => Date;
}

function makeDeps(
  review: ReviewPipelineResult = reviewResult(),
  { agents = [makeAgent("correctness")], ...options }: DepsOptions = {},
) {
  const client = makeClient();
  const runReviewPipeline = vi.fn(
    async (
      _client: GithubInstallationClient,
      _context: ReviewContext,
      _agents: readonly AgentDefinition[],
    ) => review,
  );
  const { logger, entries } = createCapturingLogger();
  return {
    client,
    runReviewPipeline,
    entries,
    deps: { client, agents, runReviewPipeline, logger, ...options },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reviewPullRequest", () => {
  it("loads the PR, its changed files, and its diff concurrently", async () => {
    const { deps, client } = makeDeps();

    await reviewPullRequest(target, deps);

    expect(client.getPullRequest).toHaveBeenCalledExactlyOnceWith(target);
    expect(client.listChangedFiles).toHaveBeenCalledExactlyOnceWith(target);
    expect(client.getDiff).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("runs the pipeline against the loaded context with the same client", async () => {
    const agents = [makeAgent("correctness")];
    const { deps, client, runReviewPipeline } = makeDeps(reviewResult(), {
      agents,
    });

    await reviewPullRequest(target, deps);

    expect(runReviewPipeline).toHaveBeenCalledExactlyOnceWith(
      client,
      {
        owner: target.owner,
        repo: target.repo,
        pullRequest,
        changedFiles,
        diff,
      },
      agents,
    );
  });

  it("publishes a check run through the client by default", async () => {
    const { deps, client } = makeDeps(reviewResult({ candidates: [finding] }));

    await reviewPullRequest(target, deps);

    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    expect(client.createCheckRun.mock.calls[0]?.[0]).toMatchObject({
      owner: target.owner,
      repo: target.repo,
      headSha: target.headSha,
      conclusion: "neutral",
    });
  });

  it("uses an injected publisher instead of the check run when given one", async () => {
    const publishReview = vi.fn<PublishReview>(async () => undefined);
    const { deps, client } = makeDeps(reviewResult({ candidates: [finding] }), {
      publishReview,
    });

    await reviewPullRequest(target, deps);

    expect(client.createCheckRun).not.toHaveBeenCalled();
    expect(publishReview).toHaveBeenCalledTimes(1);
    const [publishedTarget, rendered] = publishReview.mock.calls[0] ?? [];
    expect(publishedTarget).toEqual(target);
    expect(rendered?.output.summary).toContain(finding.title);
  });

  it("returns the pipeline result so callers can inspect the review", async () => {
    const review = reviewResult({ candidates: [finding] });
    const { deps } = makeDeps(review);

    await expect(reviewPullRequest(target, deps)).resolves.toBe(review);
  });

  it("emits the lifecycle events for one review (spec §26)", async () => {
    const { deps, entries } = makeDeps(reviewResult({ candidates: [finding] }));

    await reviewPullRequest(target, deps);

    expect(entries.map((entry) => entry["event"])).toEqual([
      "review.loaded",
      "synthesis.started",
      "synthesis.completed",
      "findings.validated",
      "review.comments.published",
      "review.published",
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ repository: "octo-org/example-service" });
    }
  });

  it("logs synthesis.skipped for a clean review rather than a synthesis pair", async () => {
    const { deps, entries } = makeDeps();

    await reviewPullRequest(target, deps);

    const events = entries.map((entry) => entry["event"]);
    expect(events).toContain("synthesis.skipped");
    expect(events).not.toContain("synthesis.started");
  });

  it("logs synthesis.failed and still publishes when synthesis fails", async () => {
    const { deps, client, entries } = makeDeps(
      reviewResult({
        candidates: [finding],
        synthesis: {
          outcome: "failed",
          candidates: [finding],
          error: "model returned malformed JSON",
          errorName: "SynthesisError",
          durationMs: 0,
        },
      }),
    );

    await reviewPullRequest(target, deps);

    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "synthesis.failed",
        fallback: "publishing validated raw findings",
      }),
    );
    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
  });

  it("propagates a pipeline failure without publishing", async () => {
    const { deps, client, runReviewPipeline } = makeDeps();
    runReviewPipeline.mockRejectedValueOnce(new Error("every agent failed"));

    await expect(reviewPullRequest(target, deps)).rejects.toThrow(
      "every agent failed",
    );
    expect(client.createCheckRun).not.toHaveBeenCalled();
  });

  it("propagates a publish failure so the caller decides on retry", async () => {
    const publishReview = vi.fn<PublishReview>(async () => {
      throw new Error("check run rejected");
    });
    const { deps, entries } = makeDeps(reviewResult(), { publishReview });

    await expect(reviewPullRequest(target, deps)).rejects.toThrow(
      "check run rejected",
    );
    expect(entries.map((entry) => entry["event"])).not.toContain(
      "review.published",
    );
  });
});

describe("reviewPullRequest inline comments", () => {
  it("publishes a review through the client by default", async () => {
    const { deps, client } = makeDeps(reviewResult({ candidates: [finding] }));

    await reviewPullRequest(target, deps);

    expect(client.createReview).toHaveBeenCalledExactlyOnceWith({
      owner: target.owner,
      repo: target.repo,
      pullRequestNumber: target.pullRequestNumber,
      commitSha: target.headSha,
      body: expect.stringContaining("AI PR Review — 1 finding"),
      comments: [
        {
          path: finding.file,
          line: finding.line,
          body: expect.stringContaining(finding.title),
        },
      ],
    });
  });

  it("drops the check run annotations once the comments carry them", async () => {
    const { deps, client } = makeDeps(reviewResult({ candidates: [finding] }));

    await reviewPullRequest(target, deps);

    expect(
      client.createCheckRun.mock.calls[0]?.[0].output.annotations,
    ).toBeUndefined();
  });

  it("keeps the annotations when the token cannot post comments", async () => {
    const { deps, client, entries } = makeDeps(
      reviewResult({ candidates: [finding] }),
    );
    client.createReview.mockRejectedValueOnce(permissionError(403));

    await reviewPullRequest(target, deps);

    expect(
      client.createCheckRun.mock.calls[0]?.[0].output.annotations,
    ).toHaveLength(1);
    expect(entries).toContainEqual(
      expect.objectContaining({ event: "review.comments.degraded", status: 403 }),
    );
  });

  it("fails the run on a comment error that is not a permission error", async () => {
    const { deps, client } = makeDeps(reviewResult({ candidates: [finding] }));
    client.createReview.mockRejectedValueOnce(permissionError(500));

    await expect(reviewPullRequest(target, deps)).rejects.toThrow("boom");
    expect(client.createCheckRun).not.toHaveBeenCalled();
  });

  it("does not repeat a finding already commented on an earlier commit", async () => {
    const { deps, client } = makeDeps(reviewResult({ candidates: [finding] }));
    client.listReviewComments.mockResolvedValueOnce([
      { body: `stale text\n\n${findingMarker(finding)}` },
    ]);

    await reviewPullRequest(target, deps);

    expect(client.createReview).not.toHaveBeenCalled();
  });

  it("does not re-annotate a finding whose earlier comment still stands", async () => {
    const { deps, client } = makeDeps(reviewResult({ candidates: [finding] }));
    client.listReviewComments.mockResolvedValueOnce([
      { body: `stale text\n\n${findingMarker(finding)}` },
    ]);

    await reviewPullRequest(target, deps);

    expect(
      client.createCheckRun.mock.calls[0]?.[0].output.annotations,
    ).toBeUndefined();
  });

  it("names the dedupe as its own outcome, not a failure to post", async () => {
    const { deps, client, entries } = makeDeps(
      reviewResult({ candidates: [finding] }),
    );
    client.listReviewComments.mockResolvedValueOnce([
      { body: `stale text\n\n${findingMarker(finding)}` },
    ]);

    await reviewPullRequest(target, deps);

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "review.published",
        comments: "already-posted",
        annotated: false,
      }),
    );
  });

  it("names a clean review nothing-to-post rather than already-posted", async () => {
    const { deps, entries } = makeDeps();

    await reviewPullRequest(target, deps);

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "review.published",
        comments: "nothing-to-post",
      }),
    );
  });

  it("still reviews when the existing comments cannot be read", async () => {
    const { deps, client, entries } = makeDeps(
      reviewResult({ candidates: [finding] }),
    );
    client.listReviewComments.mockRejectedValueOnce(new Error("boom"));

    await reviewPullRequest(target, deps);

    expect(client.createReview).toHaveBeenCalledTimes(1);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "review.comments.list_failed",
      }),
    );
  });

  it("posts no review on a clean pull request", async () => {
    const { deps, client } = makeDeps();

    await reviewPullRequest(target, deps);

    expect(client.createReview).not.toHaveBeenCalled();
    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
  });
});

/**
 * The changed file every fixture carries is `src/sessions.ts`, so
 * `packages/**` is the pattern nothing here matches.
 */
describe("reviewPullRequest: path filters", () => {
  const gated = makeAgent("security", ["packages/**"]);
  const ungated = makeAgent("correctness");

  it("hands the pipeline only the agents the changed files woke", async () => {
    const { deps, runReviewPipeline } = makeDeps(reviewResult(), {
      agents: [ungated, gated],
    });

    await reviewPullRequest(target, deps);

    expect(runReviewPipeline.mock.calls[0]?.[2]).toEqual([ungated]);
  });

  it("wakes an agent whose pattern one changed file matches", async () => {
    const matching = makeAgent("security", ["src/**"]);
    const { deps, runReviewPipeline } = makeDeps(reviewResult(), {
      agents: [matching],
    });

    await reviewPullRequest(target, deps);

    expect(runReviewPipeline.mock.calls[0]?.[2]).toEqual([matching]);
  });

  it("logs each skipped agent with the paths it waited for", async () => {
    const { deps, entries } = makeDeps(reviewResult(), {
      agents: [ungated, gated],
    });

    await reviewPullRequest(target, deps);

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "agent.skipped",
        agent: "security",
        paths: ["packages/**"],
        repository: "octo-org/example-service",
      }),
    );
  });

  it("names the skipped agent in the published check run", async () => {
    const { deps, client } = makeDeps(reviewResult({ candidates: [finding] }), {
      agents: [ungated, gated],
    });

    await reviewPullRequest(target, deps);

    expect(client.createCheckRun.mock.calls[0]?.[0].output.summary).toMatch(
      /security review did not run/i,
    );
  });

  describe("when no agent matches", () => {
    const only = { agents: [gated] };

    it("never calls the pipeline, so the review costs nothing", async () => {
      const { deps, runReviewPipeline } = makeDeps(reviewResult(), only);

      await reviewPullRequest(target, deps);

      expect(runReviewPipeline).not.toHaveBeenCalled();
    });

    it("still publishes a check run, and never a green one", async () => {
      // The whole point: a pull request nothing reviewed must not be
      // indistinguishable from one that came back clean.
      const { deps, client } = makeDeps(reviewResult(), only);

      await reviewPullRequest(target, deps);

      const published = client.createCheckRun.mock.calls[0]?.[0];
      expect(published?.conclusion).toBe("neutral");
      expect(published?.output.title).toBe(
        "No agent reviewed this pull request",
      );
      expect(published?.output.summary).toContain("`packages/**`");
      expect(published?.output.summary).toContain("`src/sessions.ts`");
    });

    it("posts no review comments", async () => {
      const { deps, client } = makeDeps(reviewResult(), only);

      await reviewPullRequest(target, deps);

      expect(client.createReview).not.toHaveBeenCalled();
      expect(client.listReviewComments).not.toHaveBeenCalled();
    });

    it("reports the skip to the caller as an empty review", async () => {
      const { deps } = makeDeps(reviewResult(), only);

      await expect(reviewPullRequest(target, deps)).resolves.toMatchObject({
        findings: [],
        candidates: [],
        agentFailures: [],
        synthesis: { outcome: "skipped" },
      });
    });

    it("logs the lifecycle of a review that never ran", async () => {
      const { deps, entries } = makeDeps(reviewResult(), only);

      await reviewPullRequest(target, deps);

      expect(entries.map((entry) => entry["event"])).toEqual([
        "review.loaded",
        "agent.skipped",
        "review.no_agents_matched",
      ]);
    });

    it("uses the injected publisher, so the fork fallback still applies", async () => {
      const publishReview = vi.fn<PublishReview>(async () => undefined);
      const { deps, client } = makeDeps(reviewResult(), {
        ...only,
        publishReview,
      });

      await reviewPullRequest(target, deps);

      expect(client.createCheckRun).not.toHaveBeenCalled();
      expect(publishReview).toHaveBeenCalledTimes(1);
    });
  });
});


const NOW = new Date("2026-09-13T12:00:00.000Z");

/** A memory file holding one shape, built through the schema the reader parses. */
function memoryFile(overrides: Partial<MemoryShape> = {}): string {
  return JSON.stringify(
    reviewMemorySchema.parse({
      version: 1,
      shapes: [
        {
          category: "correctness",
          shape: "assignment instead of comparison in",
          resolved: 0,
          ignored: 5,
          outdated: 0,
          lastSignalAt: NOW.toISOString(),
          ...overrides,
        },
      ],
    }),
  );
}

function readOnlyStore(content: string): MemoryStore {
  return {
    read: () => Promise.resolve(content),
    write: () => Promise.resolve(),
  };
}

describe("reviewPullRequest: repository hints", () => {
  it("hands the pipeline agents carrying the memory's qualifying shapes", async () => {
    const { deps, runReviewPipeline } = makeDeps(reviewResult(), {
      memoryStore: readOnlyStore(memoryFile()),
      now: () => NOW,
    });

    await reviewPullRequest(target, deps);

    const [hinted] = runReviewPipeline.mock.calls[0]?.[2] ?? [];
    expect(hinted?.repositoryHints).toHaveLength(1);
    expect(hinted?.repositoryHints?.[0]).toContain(
      '"assignment instead of comparison in"',
    );
  });

  it("logs which agents the hints reached", async () => {
    const { deps, entries } = makeDeps(reviewResult(), {
      memoryStore: readOnlyStore(memoryFile()),
      now: () => NOW,
    });

    await reviewPullRequest(target, deps);

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "memory.hints_attached",
        repository: "octo-org/example-service",
        hintCount: 1,
        agents: ["correctness"],
      }),
    );
  });

  it("logs an empty attachment when no shape qualifies", async () => {
    const { deps, runReviewPipeline, entries } = makeDeps(reviewResult(), {
      memoryStore: readOnlyStore(memoryFile({ ignored: 1 })),
      now: () => NOW,
    });

    await reviewPullRequest(target, deps);

    const [unhinted] = runReviewPipeline.mock.calls[0]?.[2] ?? [];
    expect(unhinted?.repositoryHints).toBeUndefined();
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "memory.hints_attached",
        hintCount: 0,
        agents: [],
      }),
    );
  });

  it("passes the agents through untouched when there is no memory store", async () => {
    const agent = makeAgent("correctness");
    const { deps, runReviewPipeline, entries } = makeDeps(reviewResult(), {
      agents: [agent],
    });

    await reviewPullRequest(target, deps);

    expect(runReviewPipeline.mock.calls[0]?.[2]?.[0]).toBe(agent);
    expect(entries.map((entry) => entry["event"])).not.toContain(
      "memory.hints_attached",
    );
  });

  it("reviews without hints when the memory cannot be read", async () => {
    const agent = makeAgent("correctness");
    const { deps, client, runReviewPipeline, entries } = makeDeps(
      reviewResult({ candidates: [finding] }),
      {
        agents: [agent],
        memoryStore: {
          read: () => Promise.reject(new Error("branch unreachable")),
          write: () => Promise.resolve(),
        },
      },
    );

    await reviewPullRequest(target, deps);

    expect(client.createCheckRun).toHaveBeenCalledTimes(1);
    expect(runReviewPipeline.mock.calls[0]?.[2]?.[0]).toBe(agent);
    // readMemory absorbs the transport error, so it surfaces as memory.invalid.
    expect(entries).toContainEqual(
      expect.objectContaining({ level: "error", event: "memory.invalid" }),
    );
  });
});
