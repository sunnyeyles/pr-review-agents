import type { ReviewThread } from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import type { ReviewMemory } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import { learnFromMergedPullRequest } from "./learn-from-merge.js";
import { type MemoryStore } from "./memory.js";
import type { ReviewTarget } from "./review-target.js";

const NOW = new Date("2026-09-13T12:00:00.000Z");

const target: ReviewTarget = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

/** A thread whose first comment carries both of our markers. */
function ourThread(
  title: string,
  state: Partial<Pick<ReviewThread, "isResolved" | "isOutdated">> = {},
): ReviewThread {
  return {
    body: [
      `**${title}**`,
      "",
      `<!-- pr-review-finding: src/sessions.ts|${title} -->`,
      "<!-- pr-review-category: security -->",
    ].join("\n"),
    isResolved: false,
    isOutdated: false,
    ...state,
  };
}

function fakeClient(threads: ReviewThread[] | Error) {
  return {
    listReviewThreads: () =>
      threads instanceof Error
        ? Promise.reject(threads)
        : Promise.resolve(threads),
  };
}

function fakeStore(
  content?: string,
  writeError?: Error,
): MemoryStore & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    read: () => Promise.resolve(content),
    write: (value) => {
      if (writeError !== undefined) {
        return Promise.reject(writeError);
      }
      written.push(value);
      return Promise.resolve();
    },
  };
}

function writtenMemory(store: { written: string[] }): ReviewMemory {
  return JSON.parse(store.written[0] ?? "null") as ReviewMemory;
}

describe("learnFromMergedPullRequest", () => {
  it("classifies each thread by its resolution state", async () => {
    const { logger, entries } = createCapturingLogger();
    const store = fakeStore();

    const result = await learnFromMergedPullRequest(target, {
      client: fakeClient([
        ourThread("Missing tenant check", { isResolved: true }),
        ourThread("Unbounded query", { isOutdated: true }),
        ourThread("Prefer a constant"),
      ]),
      store,
      logger,
      now: NOW,
    });

    expect(result).toEqual({ signals: 3 });
    expect(writtenMemory(store).shapes).toEqual([
      expect.objectContaining({ shape: "missing tenant check", resolved: 1 }),
      expect.objectContaining({ shape: "unbounded query", outdated: 1 }),
      expect.objectContaining({ shape: "prefer a constant", ignored: 1 }),
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "memory.updated",
        repository: "octo-org/example-service",
        pullRequestNumber: 42,
        signals: 3,
        resolved: 1,
        outdated: 1,
        ignored: 1,
      }),
    );
  });

  it("counts a resolved thread as resolved even when it is also outdated", async () => {
    const { logger } = createCapturingLogger();
    const store = fakeStore();

    await learnFromMergedPullRequest(target, {
      client: fakeClient([
        ourThread("Missing tenant check", { isResolved: true, isOutdated: true }),
      ]),
      store,
      logger,
      now: NOW,
    });

    expect(writtenMemory(store).shapes[0]).toMatchObject({
      resolved: 1,
      outdated: 0,
    });
  });

  it("folds the signals into the memory already on the branch", async () => {
    const { logger } = createCapturingLogger();
    const existing: ReviewMemory = {
      version: 1,
      shapes: [
        {
          category: "security",
          shape: "missing tenant check",
          resolved: 0,
          ignored: 4,
          outdated: 0,
          lastSignalAt: NOW.toISOString(),
        },
      ],
    };
    const store = fakeStore(JSON.stringify(existing));

    await learnFromMergedPullRequest(target, {
      client: fakeClient([ourThread("Missing tenant check")]),
      store,
      logger,
      now: NOW,
    });

    expect(writtenMemory(store).shapes[0]).toMatchObject({ ignored: 5 });
  });

  it("skips threads that are not our findings", async () => {
    const { logger, entries } = createCapturingLogger();
    const store = fakeStore();

    const result = await learnFromMergedPullRequest(target, {
      client: fakeClient([
        { body: "Nit: rename this", isResolved: true, isOutdated: false },
        {
          body: "<!-- pr-review-finding: src/a.ts|Old finding -->",
          isResolved: false,
          isOutdated: false,
        },
      ]),
      store,
      logger,
      now: NOW,
    });

    expect(result).toEqual({ signals: 0 });
    expect(store.written).toEqual([]);
    expect(entries).toContainEqual(
      expect.objectContaining({ event: "memory.no_signals" }),
    );
  });

  it("writes nothing when the pull request carried no review threads", async () => {
    const { logger, entries } = createCapturingLogger();
    const store = fakeStore();

    await learnFromMergedPullRequest(target, {
      client: fakeClient([]),
      store,
      logger,
      now: NOW,
    });

    expect(store.written).toEqual([]);
    expect(entries.map((entry) => entry["event"])).toEqual(["memory.no_signals"]);
  });

  it("logs rather than throws when the threads cannot be read", async () => {
    const { logger, entries } = createCapturingLogger();
    const store = fakeStore();

    const result = await learnFromMergedPullRequest(target, {
      client: fakeClient(new Error("HTTP 403")),
      store,
      logger,
      now: NOW,
    });

    expect(result).toEqual({ signals: 0 });
    expect(store.written).toEqual([]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "memory.update_failed",
        error: "HTTP 403",
        repository: "octo-org/example-service",
      }),
    );
  });

  it("logs rather than throws when the memory cannot be written", async () => {
    const { logger, entries } = createCapturingLogger();
    const store = fakeStore(undefined, new Error("HTTP 403: contents write"));

    const result = await learnFromMergedPullRequest(target, {
      client: fakeClient([ourThread("Missing tenant check")]),
      store,
      logger,
      now: NOW,
    });

    expect(result).toEqual({ signals: 0 });
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "memory.update_failed",
        error: "HTTP 403: contents write",
      }),
    );
  });
});
