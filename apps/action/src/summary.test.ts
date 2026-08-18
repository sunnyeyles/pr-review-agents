import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCapturingLogger } from "@pr-review/logging";
import type { PublishReview, RenderedCheckRun, ReviewTarget } from "@pr-review/reviewer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendJobSummary,
  createFallbackPublisher,
  httpStatus,
  isPermissionError,
  renderJobSummary,
} from "./summary.js";

const target: ReviewTarget = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

const rendered: RenderedCheckRun = {
  conclusion: "neutral",
  output: {
    title: "1 finding",
    summary: "**1 finding**\n\nSession token logged in plaintext",
  },
};

/** An Octokit RequestError carries the HTTP status on `.status`. */
function requestError(status: number, message = "request failed"): Error {
  return Object.assign(new Error(message), { status, name: "HttpError" });
}

const tempDirs: string[] = [];

async function tempSummaryPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-review-summary-"));
  tempDirs.push(dir);
  return path.join(dir, "summary.md");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("httpStatus", () => {
  it("reads the status off an Octokit request error", () => {
    expect(httpStatus(requestError(403))).toBe(403);
  });

  it("returns undefined for errors without a numeric status", () => {
    expect(httpStatus(new Error("boom"))).toBeUndefined();
    expect(httpStatus({ status: "403" })).toBeUndefined();
    expect(httpStatus(null)).toBeUndefined();
    expect(httpStatus(undefined)).toBeUndefined();
  });
});

describe("renderJobSummary", () => {
  it("includes the check run title and summary", () => {
    const markdown = renderJobSummary(target, rendered);
    expect(markdown).toContain("1 finding");
    expect(markdown).toContain("Session token logged in plaintext");
  });

  it("names the pull request and the reviewed commit", () => {
    const markdown = renderJobSummary(target, rendered);
    expect(markdown).toContain("octo-org/example-service#42");
    expect(markdown).toContain("6dcb09b");
  });

  it("explains why the review is here rather than on a check run", () => {
    expect(renderJobSummary(target, rendered)).toMatch(/annotations are unavailable/i);
  });
});

describe("appendJobSummary", () => {
  it("appends to the summary file and reports success", async () => {
    const summaryPath = await tempSummaryPath();

    await expect(appendJobSummary("first\n", summaryPath)).resolves.toBe(true);
    await expect(appendJobSummary("second\n", summaryPath)).resolves.toBe(true);

    expect(await readFile(summaryPath, "utf8")).toBe("first\nsecond\n");
  });

  it("reports failure when no summary file is available", async () => {
    await expect(appendJobSummary("x", undefined)).resolves.toBe(false);
    await expect(appendJobSummary("x", "")).resolves.toBe(false);
  });
});

describe("createFallbackPublisher", () => {
  async function makePublisher(publishCheckRun: PublishReview) {
    const summaryPath = await tempSummaryPath();
    const { logger, entries } = createCapturingLogger();
    return {
      summaryPath,
      entries,
      publish: createFallbackPublisher({ publishCheckRun, summaryPath, logger }),
    };
  }

  it("publishes the check run and writes no summary when permitted", async () => {
    const publishCheckRun = vi.fn<PublishReview>(async () => undefined);
    const { publish, summaryPath, entries } = await makePublisher(publishCheckRun);

    await publish(target, rendered);

    expect(publishCheckRun).toHaveBeenCalledExactlyOnceWith(target, rendered);
    await expect(readFile(summaryPath, "utf8")).rejects.toThrow();
    expect(entries).toEqual([]);
  });

  it("rethrows failures that are not permission problems", async () => {
    const publishCheckRun = vi.fn<PublishReview>(async () => {
      throw requestError(500, "internal server error");
    });
    const { publish, summaryPath } = await makePublisher(publishCheckRun);

    await expect(publish(target, rendered)).rejects.toThrow(
      "internal server error",
    );
    // A real outage must not masquerade as a delivered review.
    await expect(readFile(summaryPath, "utf8")).rejects.toThrow();
  });

  it("writes the review to the job summary when the token cannot create check runs", async () => {
    const publishCheckRun = vi.fn<PublishReview>(async () => {
      throw requestError(403, "Resource not accessible by integration");
    });
    const { publish, summaryPath, entries } = await makePublisher(publishCheckRun);

    await expect(publish(target, rendered)).resolves.toBeUndefined();

    expect(await readFile(summaryPath, "utf8")).toContain(
      "Session token logged in plaintext",
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "review.published.degraded",
        surface: "job-summary",
        status: 403,
      }),
    );
  });

  it("rethrows a permission error when there is no job summary to fall back to", async () => {
    const { logger } = createCapturingLogger();
    const publish = createFallbackPublisher({
      publishCheckRun: async () => {
        throw requestError(403, "Resource not accessible by integration");
      },
      summaryPath: undefined,
      logger,
    });

    await expect(publish(target, rendered)).rejects.toThrow(
      "Resource not accessible by integration",
    );
  });
});

describe("isPermissionError", () => {
  it("treats 403 as a missing checks: write scope", () => {
    expect(
      isPermissionError(requestError(403, "Resource not accessible by integration")),
    ).toBe(true);
  });

  it("treats 404 as a hidden resource, which a read-only token produces", () => {
    expect(isPermissionError(requestError(404, "Not Found"))).toBe(true);
  });

  it("does not treat an invalid or expired token as a fork", () => {
    expect(isPermissionError(requestError(401, "Bad credentials"))).toBe(false);
  });

  it("does not treat server errors as permission problems", () => {
    expect(isPermissionError(requestError(500))).toBe(false);
    expect(isPermissionError(requestError(502))).toBe(false);
  });

  it("does not treat a rate limit as a permission problem", () => {
    expect(isPermissionError(requestError(429, "rate limit exceeded"))).toBe(false);
  });

  it("does not treat network failures as permission problems", () => {
    expect(isPermissionError(new Error("ECONNRESET"))).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
  });
});
