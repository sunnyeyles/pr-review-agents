import type { ChangedFile } from "@pr-review/github";
import { describe, expect, it } from "vitest";

import { buildChangedLineIndex, changedLinesFromPatch } from "./diff-lines.js";

describe("changedLinesFromPatch", () => {
  it("returns the new-side line numbers of added lines in a single hunk", () => {
    const patch = [
      "@@ -9,1 +9,4 @@ export function session() {",
      " const context = 9;",
      "+const added10 = true;",
      "+const added11 = true;",
      "+const added12 = true;",
    ].join("\n");

    expect(changedLinesFromPatch(patch)).toEqual(new Set([10, 11, 12]));
  });

  it("does not count context lines as changed", () => {
    const patch = [
      "@@ -1,3 +1,4 @@",
      " context line 1",
      " context line 2",
      "+added line 3",
      " context line 4",
    ].join("\n");

    expect(changedLinesFromPatch(patch)).toEqual(new Set([3]));
  });

  it("does not let removed lines advance the new-side counter", () => {
    const patch = [
      "@@ -1,3 +1,2 @@",
      " context line 1",
      "-removed old line 2",
      "-removed old line 3",
      "+added line 2",
    ].join("\n");

    expect(changedLinesFromPatch(patch)).toEqual(new Set([2]));
  });

  it("tracks line numbers across multiple hunks", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " context",
      "+added line 2",
      " context",
      "@@ -40,2 +41,3 @@",
      " context line 41",
      "+added line 42",
      " context line 43",
    ].join("\n");

    expect(changedLinesFromPatch(patch)).toEqual(new Set([2, 42]));
  });

  it("handles hunk headers without an explicit count", () => {
    const patch = ["@@ -1 +1,2 @@", " context line 1", "+added line 2"].join(
      "\n",
    );

    expect(changedLinesFromPatch(patch)).toEqual(new Set([2]));
  });

  it('ignores the "no newline at end of file" marker', () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      " context",
      "-old last line",
      "\\ No newline at end of file",
      "+new last line",
      "\\ No newline at end of file",
    ].join("\n");

    expect(changedLinesFromPatch(patch)).toEqual(new Set([2]));
  });

  it("returns an empty set for a deletion-only patch", () => {
    const patch = ["@@ -1,2 +1,1 @@", " context", "-removed"].join("\n");

    expect(changedLinesFromPatch(patch)).toEqual(new Set());
  });

  it("returns an empty set for a hunk header with no body", () => {
    expect(changedLinesFromPatch("@@ -1 +1,2 @@")).toEqual(new Set());
  });
});

describe("buildChangedLineIndex", () => {
  function file(filename: string, patch?: string): ChangedFile {
    return { filename, status: "modified", additions: 1, deletions: 0, patch };
  }

  it("indexes every changed file by filename", () => {
    const index = buildChangedLineIndex([
      file("src/a.ts", "@@ -1 +1,2 @@\n context\n+added"),
      file("src/b.ts", "@@ -5,2 +5,3 @@\n context 5\n+added 6\n context 7"),
    ]);

    expect([...index.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(index.get("src/a.ts")).toEqual(new Set([2]));
    expect(index.get("src/b.ts")).toEqual(new Set([6]));
  });

  it("maps files without a patch (e.g. binary files) to an empty set", () => {
    const index = buildChangedLineIndex([file("assets/logo.png")]);

    expect(index.get("assets/logo.png")).toEqual(new Set());
  });

  it("returns an empty index for no changed files", () => {
    expect(buildChangedLineIndex([]).size).toBe(0);
  });
});
