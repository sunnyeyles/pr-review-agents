import { emptyTokenUsage, type ReviewContext } from "@pr-review/ai";
import type {
  ChangedFile,
  CreateCheckRunInput,
  CreateReviewInput,
  GithubInstallationClient,
  PullRequestDetails,
  PullRequestRef,
} from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import type { PublishReview, ReviewPipelineResult } from "@pr-review/reviewer";
import type { ReviewFinding } from "@pr-review/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActionHandler } from "./handler.js";

const headSha = "6dcb09b5b57875f334f61aebed695e2e4193db5e";

const pullRequest: PullRequestDetails = {
  number: 42,
  title: "Add rate limiting to the sessions endpoint",
  body: "Adds a token bucket to the sessions endpoint.",
  author: "octocat",
  baseRef: "main",
  baseSha: "0000000000000000000000000000000000000000",
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
];

const finding: ReviewFinding = {
  file: "src/sessions.ts",
  line: 2,
  category: "security",
  severity: "high",
  title: "Session token logged in plaintext",
  explanation: "The session token is written to the request log on every call.",
  confidence: 0.9,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: { name: "example-service", owner: { login: "octo-org" } },
    pull_request: {
      number: 42,
      head: { sha: headSha, repo: { full_name: "octo-org/example-service" } },
    },
    ...overrides,
  };
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

function makeHandler(review: ReviewPipelineResult = reviewResult()) {
  const client = {
    getPullRequest: vi.fn(async (_ref: PullRequestRef) => pullRequest),
    listChangedFiles: vi.fn(async (_ref: PullRequestRef) => changedFiles),
    getDiff: vi.fn(async (_ref: PullRequestRef) => "diff --git a/x b/x\n"),
    getFileContents: vi.fn(async () => "export const sessions = [];\n"),
    searchCode: vi.fn(async () => []),
    listReviewComments: vi.fn(async () => []),
    createCheckRun: vi.fn(async (_input: CreateCheckRunInput) => ({ id: 987 })),
    createReview: vi.fn(async (_input: CreateReviewInput) => ({ id: 654 })),
  } satisfies GithubInstallationClient;
  const runReviewPipeline = vi.fn(
    async (_client: GithubInstallationClient, _context: ReviewContext) => review,
  );
  const publishReview = vi.fn<PublishReview>(async () => undefined);
  const { logger, entries } = createCapturingLogger();
  const handler = createActionHandler({
    client,
    runReviewPipeline,
    publishReview,
    logger,
  });
  return { handler, client, runReviewPipeline, publishReview, entries };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createActionHandler", () => {
  it("reviews a supported pull request event", async () => {
    const { handler, runReviewPipeline, publishReview } = makeHandler(
      reviewResult({ candidates: [finding] }),
    );

    await expect(handler(payload(), "pull_request")).resolves.toEqual({
      reviewed: true,
    });
    expect(runReviewPipeline).toHaveBeenCalledTimes(1);
    expect(publishReview).toHaveBeenCalledTimes(1);
  });

  it("publishes the rendered review for the event's repository and head SHA", async () => {
    const { handler, publishReview } = makeHandler(
      reviewResult({ candidates: [finding] }),
    );

    await handler(payload(), "pull_request");

    const [target, rendered] = publishReview.mock.calls[0] ?? [];
    expect(target).toEqual({
      owner: "octo-org",
      repo: "example-service",
      pullRequestNumber: 42,
      headSha,
    });
    expect(rendered?.conclusion).toBe("neutral");
    expect(rendered?.output.summary).toContain(finding.title);
  });

  it("ignores an unrelated action without running the pipeline", async () => {
    const { handler, runReviewPipeline, publishReview } = makeHandler();

    await expect(
      handler(payload({ action: "labeled" }), "pull_request"),
    ).resolves.toEqual({ reviewed: false, reason: "action ignored: labeled" });
    expect(runReviewPipeline).not.toHaveBeenCalled();
    expect(publishReview).not.toHaveBeenCalled();
  });

  it("ignores an unrelated event without running the pipeline", async () => {
    const { handler, runReviewPipeline } = makeHandler();

    await expect(handler(payload(), "push")).resolves.toMatchObject({
      reviewed: false,
    });
    expect(runReviewPipeline).not.toHaveBeenCalled();
  });

  it("records whether the head branch came from a fork", async () => {
    const { handler, entries } = makeHandler();

    await handler(
      payload({
        pull_request: {
          number: 42,
          head: {
            sha: headSha,
            repo: { full_name: "contributor/example-service" },
          },
        },
      }),
      "pull_request",
    );

    expect(entries).toContainEqual(
      expect.objectContaining({ event: "review.started", isFork: true }),
    );
  });

  it("fails the run when the review pipeline fails outright", async () => {
    const { handler, runReviewPipeline, publishReview } = makeHandler();
    runReviewPipeline.mockRejectedValueOnce(new Error("every agent failed"));

    await expect(handler(payload(), "pull_request")).rejects.toThrow(
      "every agent failed",
    );
    expect(publishReview).not.toHaveBeenCalled();
  });

  it("fails the run when the event payload is malformed", async () => {
    const { handler } = makeHandler();

    await expect(
      handler({ action: "opened", repository: {} }, "pull_request"),
    ).rejects.toThrow(/failed schema validation/);
  });
});
