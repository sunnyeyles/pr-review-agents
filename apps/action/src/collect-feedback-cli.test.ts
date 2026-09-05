/** The collector command's wiring: arguments, credentials, exit codes, and the summary. */
import type { GithubFeedbackClient, RepositoryRef } from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SINCE_DAYS,
  main,
  parseCollectArgs,
  parseRepository,
} from "./collect-feedback-cli.js";
import { USAGE_EXIT_CODE } from "./cli-env.js";

const CREDENTIALS = {
  LANGFUSE_PUBLIC_KEY: "pk-test",
  LANGFUSE_SECRET_KEY: "sk-test",
  GITHUB_TOKEN: "ghs_token",
  GITHUB_REPOSITORY: "octo-org/example-service",
};

const now = new Date("2026-09-04T12:00:00Z");

function harness(env: Record<string, string | undefined> = CREDENTIALS) {
  const lines: string[] = [];
  const github = {
    listPullRequestsUpdatedSince: vi.fn(async (_repository: RepositoryRef, _since: Date) => []),
    listReactedReviewComments: vi.fn(async () => []),
    listReviewCommentReactions: vi.fn(async () => []),
    getCollaboratorPermission: vi.fn(async () => "none" as const),
  } satisfies GithubFeedbackClient;
  const createGithub = vi.fn(() => github);
  const createSink = vi.fn(() => ({ record: vi.fn(), flush: vi.fn(async () => {}) }));
  return {
    lines,
    github,
    createGithub,
    createSink,
    environment: {
      env,
      createGithub,
      createSink,
      now: () => now,
      logger: createCapturingLogger().logger,
      write: (line: string) => {
        lines.push(line);
      },
    },
  };
}

describe("parseCollectArgs", () => {
  it("defaults to the last two weeks, every repository from the environment, and a real run", () => {
    expect(parseCollectArgs([])).toEqual({
      repository: undefined,
      sinceDays: DEFAULT_SINCE_DAYS,
      dryRun: false,
    });
  });

  it("reads each flag in both spellings and skips pnpm's separator", () => {
    expect(
      parseCollectArgs(["--", "--repo", "a/b", "--since-days=3", "--dry-run"]),
    ).toEqual({ repository: "a/b", sinceDays: 3, dryRun: true });
    expect(parseCollectArgs(["--repo=a/b", "--since-days", "30"])).toEqual({
      repository: "a/b",
      sinceDays: 30,
      dryRun: false,
    });
  });

  it("rejects a bad day count, a missing value, and an unknown flag", () => {
    expect(() => parseCollectArgs(["--since-days", "0"])).toThrow("positive whole number");
    expect(() => parseCollectArgs(["--since-days", "1.5"])).toThrow("positive whole number");
    expect(() => parseCollectArgs(["--repo"])).toThrow("--repo needs a value");
    expect(() => parseCollectArgs(["--dryrun"])).toThrow("Unknown argument: --dryrun");
  });
});

describe("parseRepository", () => {
  it("splits owner/name", () => {
    expect(parseRepository(" octo-org/example ")).toEqual({
      owner: "octo-org",
      repo: "example",
    });
  });

  it("rejects anything else", () => {
    expect(() => parseRepository("example")).toThrow("owner/name");
    expect(() => parseRepository("a/b/c")).toThrow("owner/name");
    expect(() => parseRepository("")).toThrow("GITHUB_REPOSITORY");
  });
});

describe("main", () => {
  it("collects over the repository from the environment and prints the report", async () => {
    const { environment, lines, createGithub, createSink, github } = harness();

    const code = await main([], environment);

    expect(code).toBe(0);
    expect(createGithub).toHaveBeenCalledExactlyOnceWith({ token: "ghs_token" });
    expect(createSink).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ publicKey: "pk-test", secretKey: "sk-test" }),
    );
    expect(github.listPullRequestsUpdatedSince).toHaveBeenCalledExactlyOnceWith(
      { owner: "octo-org", repo: "example-service" },
      new Date("2026-08-21T12:00:00Z"),
    );
    expect(lines[0]).toContain("octo-org/example-service");
    expect(lines.join("\n")).toContain("scores recorded");
  });

  it("prefers --repo over the environment and labels a dry run", async () => {
    const { environment, lines, github } = harness();

    await main(["--repo", "other/repo", "--dry-run"], environment);

    expect(github.listPullRequestsUpdatedSince.mock.calls[0]?.[0]).toEqual({
      owner: "other",
      repo: "repo",
    });
    expect(lines[0]).toContain("dry run");
    expect(lines.join("\n")).toContain("scores that would land");
  });

  it("exits with the usage code, touching nothing, when a credential is missing", async () => {
    for (const missing of ["LANGFUSE_SECRET_KEY", "GITHUB_TOKEN", "GITHUB_REPOSITORY"]) {
      const { environment, lines, createGithub, createSink } = harness({
        ...CREDENTIALS,
        [missing]: undefined,
      });

      const code = await main([], environment);

      expect(code, missing).toBe(USAGE_EXIT_CODE);
      expect(lines.join("\n"), missing).toContain(missing);
      expect(createGithub).not.toHaveBeenCalled();
      expect(createSink).not.toHaveBeenCalled();
    }
  });

  it("exits with the usage code on a bad argument", async () => {
    const { environment, lines } = harness();

    expect(await main(["--nope"], environment)).toBe(USAGE_EXIT_CODE);
    expect(lines[0]).toContain("Unknown argument");
  });
});
