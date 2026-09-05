import type { FeedbackScore, FeedbackScoreSink } from "@pr-review/ai";
import type {
  CollaboratorPermission,
  CommentReaction,
  GithubFeedbackClient,
  ReactedReviewComment,
} from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it, vi } from "vitest";

import { canPush, collectFeedback } from "./collect-feedback.js";
import { feedbackMarker, findingMarker } from "./render-review.js";

const repository = { owner: "octo-org", repo: "example-service" };
const traceId = "0af7651916cd43dd8448eb211c80319c";
const since = new Date("2026-08-20T00:00:00Z");

const finding = {
  file: "src/sessions.ts",
  line: 12,
  category: "security",
  severity: "high" as const,
  title: "Open redirect",
  explanation: "…",
  confidence: 0.9,
};

/** A comment body as renderReview posts it. */
function body(meta: { traceId?: string; category?: string } = {}): string {
  return [
    "**HIGH — Security: Open redirect**",
    "",
    findingMarker(finding),
    feedbackMarker({ category: meta.category ?? "security", traceId: meta.traceId ?? traceId }),
  ].join("\n");
}

interface Fixture {
  comments?: ReactedReviewComment[];
  reactions?: Record<number, CommentReaction[]>;
  permissions?: Record<string, CollaboratorPermission>;
}

function github(fixture: Fixture = {}) {
  const client = {
    listPullRequestsUpdatedSince: vi.fn(async () => [
      { number: 42, updatedAt: new Date("2026-09-01T00:00:00Z") },
    ]),
    listReactedReviewComments: vi.fn(async () => fixture.comments ?? []),
    listReviewCommentReactions: vi.fn(
      async (_repository, commentId: number) => fixture.reactions?.[commentId] ?? [],
    ),
    getCollaboratorPermission: vi.fn(
      async (_repository, username: string) => fixture.permissions?.[username] ?? "none",
    ),
  } satisfies GithubFeedbackClient;
  return client;
}

function sink() {
  const recorded: FeedbackScore[] = [];
  const flush = vi.fn(async () => {});
  const record = vi.fn((score: FeedbackScore) => {
    recorded.push(score);
  });
  return { recorded, flush, record, sink: { record, flush } satisfies FeedbackScoreSink };
}

describe("canPush", () => {
  it("counts write and admin, not read or none", () => {
    expect(canPush("admin")).toBe(true);
    expect(canPush("write")).toBe(true);
    expect(canPush("read")).toBe(false);
    expect(canPush("none")).toBe(false);
  });
});

describe("collectFeedback", () => {
  it("scores a thumbs up as 1 and a thumbs down as 0 on the run's trace", async () => {
    const client = github({
      comments: [{ id: 7, body: body(), thumbsUp: 1, thumbsDown: 1 }],
      reactions: {
        7: [
          { id: 100, content: "+1", user: "maintainer" },
          { id: 101, content: "-1", user: "reviewer" },
        ],
      },
      permissions: { maintainer: "admin", reviewer: "write" },
    });
    const { sink: scores, recorded, flush } = sink();

    const report = await collectFeedback(client, scores, { repository, since });

    expect(recorded).toEqual([
      expect.objectContaining({
        id: "github-reaction-100",
        traceId,
        value: 1,
        metadata: expect.objectContaining({
          category: "security",
          finding: "src/sessions.ts|open redirect",
          user: "maintainer",
          pullRequestNumber: 42,
        }),
      }),
      expect.objectContaining({ id: "github-reaction-101", traceId, value: 0 }),
    ]);
    expect(flush).toHaveBeenCalledOnce();
    expect(report).toEqual({
      pullRequestsVisited: 1,
      commentsScanned: 1,
      reactionsFound: 2,
      scoresRecorded: 2,
      skippedUntraced: 0,
      skippedNoWriteAccess: 0,
    });
  });

  it("ignores reactions from people who cannot push", async () => {
    const client = github({
      comments: [{ id: 7, body: body(), thumbsUp: 1, thumbsDown: 0 }],
      reactions: { 7: [{ id: 100, content: "+1", user: "drive-by" }] },
      permissions: { "drive-by": "read" },
    });
    const { sink: scores, recorded } = sink();
    const { logger, entries } = createCapturingLogger();

    const report = await collectFeedback(client, scores, { repository, since, logger });

    expect(recorded).toEqual([]);
    expect(report.skippedNoWriteAccess).toBe(1);
    expect(entries).toContainEqual(
      expect.objectContaining({ event: "feedback.skipped_no_write_access", user: "drive-by" }),
    );
  });

  it("looks a person's permission up once, however many times they reacted", async () => {
    const client = github({
      comments: [
        { id: 7, body: body(), thumbsUp: 1, thumbsDown: 0 },
        { id: 8, body: body(), thumbsUp: 1, thumbsDown: 0 },
      ],
      reactions: {
        7: [{ id: 100, content: "+1", user: "maintainer" }],
        8: [{ id: 101, content: "+1", user: "maintainer" }],
      },
      permissions: { maintainer: "write" },
    });

    await collectFeedback(client, sink().sink, { repository, since });

    expect(client.getCollaboratorPermission).toHaveBeenCalledOnce();
  });

  it("ignores reactions other than thumbs, and comments this system did not post", async () => {
    const client = github({
      comments: [
        { id: 7, body: body(), thumbsUp: 0, thumbsDown: 0 },
        { id: 8, body: "a human wrote this", thumbsUp: 3, thumbsDown: 0 },
        { id: 9, body: body(), thumbsUp: 0, thumbsDown: 1 },
      ],
      reactions: {
        8: [{ id: 200, content: "+1", user: "maintainer" }],
        9: [
          { id: 300, content: "eyes", user: "maintainer" },
          { id: 301, content: "-1", user: "maintainer" },
        ],
      },
      permissions: { maintainer: "write" },
    });
    const { sink: scores, recorded } = sink();

    const report = await collectFeedback(client, scores, { repository, since });

    // Comment 7 has no tallies, so its reactions were never fetched.
    expect(client.listReviewCommentReactions).toHaveBeenCalledTimes(1);
    expect(recorded.map((score) => score.id)).toEqual(["github-reaction-301"]);
    expect(report.commentsScanned).toBe(2);
    expect(report.reactionsFound).toBe(1);
  });

  it("counts but cannot score a reaction on a comment from an untraced run", async () => {
    const client = github({
      comments: [
        {
          id: 7,
          body: [findingMarker(finding), feedbackMarker({ category: "security" })].join("\n"),
          thumbsUp: 1,
          thumbsDown: 0,
        },
      ],
      reactions: { 7: [{ id: 100, content: "+1", user: "maintainer" }] },
      permissions: { maintainer: "write" },
    });
    const { sink: scores, recorded } = sink();

    const report = await collectFeedback(client, scores, { repository, since });

    expect(recorded).toEqual([]);
    expect(report.skippedUntraced).toBe(1);
    expect(client.listReviewCommentReactions).not.toHaveBeenCalled();
    expect(client.getCollaboratorPermission).not.toHaveBeenCalled();
  });

  it("records nothing on a dry run but reports what it would have", async () => {
    const client = github({
      comments: [{ id: 7, body: body(), thumbsUp: 1, thumbsDown: 0 }],
      reactions: { 7: [{ id: 100, content: "+1", user: "maintainer" }] },
      permissions: { maintainer: "write" },
    });
    const { sink: scores, record, flush } = sink();
    const { logger, entries } = createCapturingLogger();

    const report = await collectFeedback(client, scores, {
      repository,
      since,
      dryRun: true,
      logger,
    });

    expect(record).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(report.scoresRecorded).toBe(1);
    expect(entries).toContainEqual(
      expect.objectContaining({ event: "feedback.would_record", traceId }),
    );
  });

  it("asks GitHub only for pull requests updated since the cutoff", async () => {
    const client = github();

    await collectFeedback(client, sink().sink, { repository, since });

    expect(client.listPullRequestsUpdatedSince).toHaveBeenCalledExactlyOnceWith(
      repository,
      since,
    );
  });
});
