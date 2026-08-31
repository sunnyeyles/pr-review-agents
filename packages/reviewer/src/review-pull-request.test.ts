import { emptyTokenUsage, type ReviewContext } from "@pr-review/ai";
import type {
  ChangedFile,
  CreateCheckRunInput,
  CreateReviewInput,
  ExistingReviewComment,
  GithubInstallationClient,
  PullRequestDetails,
  PullRequestRef,
} from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import type { ReviewFinding } from "@pr-review/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RenderedCheckRun } from "./render-check-run.js";
import { findingMarker } from "./render-review.js";
import type { ReviewPipelineResult } from "./review-graph.js";
import {
  createCheckRunPublisher,
  reviewCorrelation,
  reviewPullRequest,
  type PublishReview,
  type ReviewTarget,
} from "./review-pull-request.js";

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
    searchCode: vi.fn(async () => []),
    listReviewComments: vi.fn(async (): Promise<ExistingReviewComment[]> => []),
    createCheckRun: vi.fn(async (_input: CreateCheckRunInput) => ({ id: 987 })),
    createReview: vi.fn(async (_input: CreateReviewInput) => ({ id: 654 })),
  } satisfies GithubInstallationClient;
}

function reviewResult(
  overrides: Partial<ReviewPipelineResult> = {},
): ReviewPipelineResult {
  const candidates = overrides.candidates ?? [];
  return {
    candidates,
    agentFailures: [],
    synthesisedCandidateCount: candidates.length,
    synthesisOutcome: candidates.length === 0 ? "skipped" : "completed",
    synthesisUsage: emptyTokenUsage(),
    findings: candidates as ReviewFinding[],
    ...overrides,
  };
}

function makeDeps(
  review: ReviewPipelineResult = reviewResult(),
  publishReview?: PublishReview,
) {
  const client = makeClient();
  const runReviewPipeline = vi.fn(
    async (_client: GithubInstallationClient, _context: ReviewContext) => review,
  );
  const { logger, entries } = createCapturingLogger();
  return {
    client,
    runReviewPipeline,
    entries,
    deps: { client, runReviewPipeline, publishReview, logger },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reviewCorrelation", () => {
  it("carries repository, PR number, and head SHA (spec §26)", () => {
    expect(reviewCorrelation(target)).toEqual({
      repository: "octo-org/example-service",
      pullRequestNumber: 42,
      headSha: target.headSha,
    });
  });
});

describe("reviewPullRequest", () => {
  it("loads the PR, its changed files, and its diff concurrently", async () => {
    const { deps, client } = makeDeps();

    await reviewPullRequest(target, deps);

    const ref = {
      owner: target.owner,
      repo: target.repo,
      pullRequestNumber: target.pullRequestNumber,
    };
    expect(client.getPullRequest).toHaveBeenCalledExactlyOnceWith(ref);
    expect(client.listChangedFiles).toHaveBeenCalledExactlyOnceWith(ref);
    expect(client.getDiff).toHaveBeenCalledExactlyOnceWith(ref);
  });

  it("runs the pipeline against the loaded context with the same client", async () => {
    const { deps, client, runReviewPipeline } = makeDeps();

    await reviewPullRequest(target, deps);

    expect(runReviewPipeline).toHaveBeenCalledExactlyOnceWith(client, {
      owner: target.owner,
      repo: target.repo,
      pullRequest,
      changedFiles,
      diff,
    });
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
    const { deps, client } = makeDeps(
      reviewResult({ candidates: [finding] }),
      publishReview,
    );

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
        synthesisOutcome: "failed",
        synthesisError: "model returned malformed JSON",
        synthesisErrorName: "SynthesisError",
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
    const { deps, entries } = makeDeps(reviewResult(), publishReview);

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
    expect(
      client.createCheckRun.mock.calls[0]?.[0].output.annotations,
    ).toHaveLength(1);
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

describe("createCheckRunPublisher", () => {
  it("creates the check run on the target's head SHA", async () => {
    const client = makeClient();
    const rendered: RenderedCheckRun = {
      conclusion: "success",
      output: { title: "No issues found", summary: "All clear." },
    };

    await createCheckRunPublisher(client)(target, rendered);

    expect(client.createCheckRun).toHaveBeenCalledExactlyOnceWith({
      owner: target.owner,
      repo: target.repo,
      headSha: target.headSha,
      conclusion: "success",
      output: rendered.output,
    });
  });
});
