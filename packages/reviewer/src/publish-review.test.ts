import type {
  CreateCheckRunInput,
  CreateReviewInput,
  ExistingReviewComment,
  GithubInstallationClient,
  PullRequestDetails,
} from "@pr-review/github";
import { describe, expect, it, vi } from "vitest";

import { createCheckRunPublisher } from "./publish-review.js";
import type { RenderedCheckRun } from "./render-check-run.js";
import type { ReviewTarget } from "./review-target.js";

const target: ReviewTarget = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

function makeClient() {
  return {
    getPullRequest: vi.fn(async () => ({}) as PullRequestDetails),
    listChangedFiles: vi.fn(async () => []),
    getDiff: vi.fn(async () => ""),
    getFileContents: vi.fn(async () => ""),
    searchCode: vi.fn(async () => ({
      matches: [],
      totalCount: 0,
      incompleteResults: false,
    })),
    listReviewComments: vi.fn(async (): Promise<ExistingReviewComment[]> => []),
    createCheckRun: vi.fn(async (_input: CreateCheckRunInput) => ({ id: 987 })),
    createReview: vi.fn(async (_input: CreateReviewInput) => ({ id: 654 })),
  } satisfies GithubInstallationClient;
}

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
