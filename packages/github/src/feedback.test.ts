/** The feedback client over an injected Octokit stub: paging, mapping, and the 404 case. */
import { describe, expect, it, vi } from "vitest";

import { createTokenFeedbackClient, type FeedbackOctokitLike } from "./feedback.js";

const repository = { owner: "octo-org", repo: "example-service" };

function page<T>(items: T[]): Promise<{ data: T[] }> {
  return Promise.resolve({ data: items });
}

function stub(overrides: Partial<FeedbackOctokitLike["rest"]> = {}) {
  const rest: FeedbackOctokitLike["rest"] = {
    pulls: {
      list: vi.fn(() => page([])),
      listReviewComments: vi.fn(() => page([])),
    },
    reactions: { listForPullRequestReviewComment: vi.fn(() => page([])) },
    repos: {
      getCollaboratorPermissionLevel: vi.fn(() =>
        Promise.resolve({ data: { permission: "write" } }),
      ),
    },
    ...overrides,
  };
  const createOctokit = vi.fn(() => ({ rest }));
  return {
    rest,
    createOctokit,
    client: createTokenFeedbackClient({ token: "ghs_token", createOctokit }),
  };
}

describe("createTokenFeedbackClient", () => {
  it("authenticates the Octokit with the token", () => {
    const { createOctokit } = stub();
    expect(createOctokit).toHaveBeenCalledExactlyOnceWith("ghs_token");
  });
});

describe("listPullRequestsUpdatedSince", () => {
  it("walks newest-first and stops at the first pull request older than the cutoff", async () => {
    const list = vi.fn(({ page: pageNumber }: { page: number }) =>
      pageNumber === 1
        ? page(
            Array.from({ length: 100 }, (_, index) => ({
              number: 200 - index,
              updated_at: "2026-09-01T00:00:00Z",
            })),
          )
        : page([
            { number: 100, updated_at: "2026-08-25T00:00:00Z" },
            { number: 99, updated_at: "2026-08-01T00:00:00Z" },
            { number: 98, updated_at: "2026-07-01T00:00:00Z" },
          ]),
    );
    const { client } = stub({
      pulls: { list, listReviewComments: vi.fn(() => page([])) },
    });

    const pulls = await client.listPullRequestsUpdatedSince(
      repository,
      new Date("2026-08-20T00:00:00Z"),
    );

    expect(pulls).toHaveLength(101);
    expect(pulls.at(-1)).toEqual({ number: 100, updatedAt: new Date("2026-08-25T00:00:00Z") });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      ...repository,
      state: "all",
      sort: "updated",
      direction: "desc",
    });
  });
});

describe("listReactedReviewComments", () => {
  it("maps GitHub's reaction tallies, defaulting to zero when absent", async () => {
    const { client } = stub({
      pulls: {
        list: vi.fn(() => page([])),
        listReviewComments: vi.fn(() =>
          page([
            { id: 1, body: "a", reactions: { "+1": 2, "-1": 1, eyes: 4 } },
            { id: 2, body: "b" },
          ]),
        ),
      },
    });

    const comments = await client.listReactedReviewComments({
      ...repository,
      pullRequestNumber: 42,
    });

    expect(comments).toEqual([
      { id: 1, body: "a", thumbsUp: 2, thumbsDown: 1 },
      { id: 2, body: "b", thumbsUp: 0, thumbsDown: 0 },
    ]);
  });
});

describe("listReviewCommentReactions", () => {
  it("returns who reacted how, dropping reactions from deleted accounts", async () => {
    const listForPullRequestReviewComment = vi.fn((_params: { comment_id: number }) =>
      page([
        { id: 10, content: "+1", user: { login: "maintainer" } },
        { id: 11, content: "-1", user: null },
      ]),
    );
    const { client } = stub({ reactions: { listForPullRequestReviewComment } });

    const reactions = await client.listReviewCommentReactions(repository, 7);

    expect(reactions).toEqual([{ id: 10, content: "+1", user: "maintainer" }]);
    expect(listForPullRequestReviewComment.mock.calls[0]?.[0]).toMatchObject({
      ...repository,
      comment_id: 7,
    });
  });
});

describe("getCollaboratorPermission", () => {
  it("returns the documented level", async () => {
    const { client } = stub();
    expect(await client.getCollaboratorPermission(repository, "maintainer")).toBe("write");
  });

  it("treats a 404 as not a collaborator", async () => {
    const { client } = stub({
      repos: {
        getCollaboratorPermissionLevel: vi.fn(() =>
          Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
        ),
      },
    });
    expect(await client.getCollaboratorPermission(repository, "stranger")).toBe("none");
  });

  it("reports an unknown level as no access rather than guessing", async () => {
    const { client } = stub({
      repos: {
        getCollaboratorPermissionLevel: vi.fn(() =>
          Promise.resolve({ data: { permission: "maintain" } }),
        ),
      },
    });
    expect(await client.getCollaboratorPermission(repository, "someone")).toBe("none");
  });

  it("rethrows anything that is not a 404", async () => {
    const { client } = stub({
      repos: {
        getCollaboratorPermissionLevel: vi.fn(() =>
          Promise.reject(Object.assign(new Error("rate limited"), { status: 429 })),
        ),
      },
    });
    await expect(client.getCollaboratorPermission(repository, "x")).rejects.toThrow(
      "rate limited",
    );
  });
});
