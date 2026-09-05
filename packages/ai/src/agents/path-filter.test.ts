/**
 * Path-pattern matching. A pattern that silently matches nothing would
 * retire an agent without a word, so the rejections matter as much as
 * the matches.
 */
import { describe, expect, it } from "vitest";

import { agentPathsSchema, compilePathFilter } from "./path-filter.js";

/** The files a pattern list matches, out of one fixed changed-file set. */
function matched(patterns: string[], files: string[]): string[] {
  return files.filter(compilePathFilter(patterns));
}

describe("compilePathFilter", () => {
  it("matches a directory subtree at any depth", () => {
    expect(
      matched(
        ["packages/github/**"],
        [
          "packages/github/src/client.ts",
          "packages/github/package.json",
          "packages/ai/src/index.ts",
        ],
      ),
    ).toEqual(["packages/github/src/client.ts", "packages/github/package.json"]);
  });

  it("matches a directory name wherever it appears", () => {
    expect(
      matched(
        ["**/auth/**"],
        ["apps/web/auth/session.ts", "src/auth/token.ts", "src/authorised.ts"],
      ),
    ).toEqual(["apps/web/auth/session.ts", "src/auth/token.ts"]);
  });

  it("matches dotfile directories, which are ordinary repository paths", () => {
    expect(
      matched(
        [".github/**"],
        [".github/workflows/ci.yml", ".github/pr-review-agents.yml", "README.md"],
      ),
    ).toEqual([".github/workflows/ci.yml", ".github/pr-review-agents.yml"]);
  });

  it("subtracts a negation instead of OR-ing it", () => {
    // picomatch's own array form ORs every pattern, so the negation
    // would match everything the positive pattern already matched.
    expect(
      matched(
        ["packages/**", "!**/*.test.ts"],
        [
          "packages/ai/src/runtime.ts",
          "packages/ai/src/runtime.test.ts",
          "apps/action/src/index.ts",
        ],
      ),
    ).toEqual(["packages/ai/src/runtime.ts"]);
  });

  it("matches a single directory level with one star", () => {
    expect(
      matched(
        ["apps/action/src/*.ts"],
        ["apps/action/src/index.ts", "apps/action/src/nested/deep.ts"],
      ),
    ).toEqual(["apps/action/src/index.ts"]);
  });

  it("matches nothing when every pattern is a negation", () => {
    // Rejected by the schema, so this only guards the compiler itself.
    expect(matched(["!**/*.md"], ["src/index.ts", "README.md"])).toEqual([]);
  });
});

describe("agentPathsSchema", () => {
  it("accepts a mix of positive and negated patterns", () => {
    expect(
      agentPathsSchema.parse(["packages/github/**", "!**/*.test.ts"]),
    ).toEqual(["packages/github/**", "!**/*.test.ts"]);
  });

  it("trims each pattern", () => {
    expect(agentPathsSchema.parse(["  packages/**  "])).toEqual(["packages/**"]);
  });

  it("rejects an empty list, which would gate the agent out of everything", () => {
    expect(agentPathsSchema.safeParse([]).success).toBe(false);
  });

  it("rejects a list of nothing but negations", () => {
    const parsed = agentPathsSchema.safeParse(["!**/*.md", "!docs/**"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("not a negation");
  });

  it("rejects a pattern that is not repository-relative", () => {
    for (const pattern of ["/packages/**", "./packages/**", "../other/**"]) {
      const parsed = agentPathsSchema.safeParse([pattern]);
      expect(parsed.success, pattern).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain("repository-relative");
    }
  });

  it("rejects a Windows-style separator", () => {
    const parsed = agentPathsSchema.safeParse(["packages\\github\\**"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("POSIX");
  });

  it("rejects a bare negation that negates nothing", () => {
    expect(agentPathsSchema.safeParse(["!"]).success).toBe(false);
  });
});
