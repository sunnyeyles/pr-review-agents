/**
 * Unified-diff hunk parsing. A finding's line counts as "in the diff"
 * only if it is an added line, numbered on the new side.
 */
import type { ChangedFile } from "@pr-review/github";

/** Matches `@@ -oldStart[,oldCount] +newStart[,newCount] @@ ...`. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Returns the new-side line numbers of a patch's added lines. */
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
      // Neither a removed line nor the no-newline marker consumes a
      // new-side line number.
    } else {
      // Context line (or the trailing empty split segment).
      newLine += 1;
    }
  }

  return changed;
}

/**
 * Indexes changed files by filename, each mapped to its added new-side
 * line numbers. Files without a patch map to an empty set.
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
