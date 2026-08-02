/**
 * Unified-diff hunk parsing for the deterministic findings pipeline.
 *
 * A finding's line is considered "in the diff" only if it is an ADDED
 * line: a `+` line in a hunk, numbered on the new side of the diff.
 * Context lines are unchanged code and removed lines no longer exist
 * at the head SHA, so neither is a valid anchor for a review finding.
 */
import type { ChangedFile } from "@pr-review/github";

/** Matches `@@ -oldStart[,oldCount] +newStart[,newCount] @@ ...`. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses one file's patch (as returned by the GitHub "list pull request
 * files" API) and returns the new-side line numbers of its added lines.
 */
export function changedLinesFromPatch(patch: string): Set<number> {
  const changed = new Set<number>();
  let newLine: number | undefined;

  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      newLine = Number(hunk[1] ?? "0");
      continue;
    }
    if (newLine === undefined) {
      // Preamble before the first hunk header; nothing to count.
      continue;
    }
    if (line.startsWith("+")) {
      changed.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // Removed lines exist only on the old side, and the
      // "\ No newline at end of file" marker is not a line at all:
      // neither consumes a new-side line number.
    } else {
      // Context line (or the trailing empty split segment).
      newLine += 1;
    }
  }

  return changed;
}

/**
 * Indexes a PR's changed files by filename, each mapped to the set of
 * added new-side line numbers. Files without a patch (binary files,
 * very large files) map to an empty set: they are part of the PR, but
 * no line-anchored finding on them can be verified against the diff.
 */
export function buildChangedLineIndex(
  files: readonly ChangedFile[],
): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const file of files) {
    index.set(
      file.filename,
      file.patch === undefined ? new Set() : changedLinesFromPatch(file.patch),
    );
  }
  return index;
}
