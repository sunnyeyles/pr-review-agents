/**
 * Unified-diff construction for the evaluation fixtures, which store
 * whole files rather than diffs. A plain LCS walk grouped into hunks;
 * fixture files are small, so the O(n*m) table costs nothing.
 */
import { createHash } from "node:crypto";

/** Context lines kept either side of a change, as git does by default. */
const CONTEXT_LINES = 3;

/** One line of a diff, tagged with which side(s) it appears on. */
export interface DiffOp {
  kind: "context" | "add" | "remove";
  text: string;
}

/** One hunk: its old/new-side extents and its prefixed lines. */
export interface DiffHunk {
  baseStart: number;
  baseCount: number;
  headStart: number;
  headCount: number;
  lines: string[];
}

/**
 * Splits file text into lines, dropping the trailing newline. A file
 * without one would need a "\ No newline at end of file" marker.
 */
export function toLines(text: string, path: string): string[] {
  if (text === "") {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error(
      `fixture file ${path} does not end with a newline; fixture files must, so their diffs are faithful`,
    );
  }
  return text.slice(0, -1).split("\n");
}

function lineAt(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

/** The line-level diff as a flat operation list, in new-file order. */
export function diffOps(
  base: readonly string[],
  head: readonly string[],
): DiffOp[] {
  const n = base.length;
  const m = head.length;
  // lcs[i * (m + 1) + j] = LCS length of base[i..] and head[j..].
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        lineAt(base, i) === lineAt(head, j)
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (lineAt(base, i) === lineAt(head, j)) {
      ops.push({ kind: "context", text: lineAt(base, i) });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: "remove", text: lineAt(base, i) });
      i += 1;
    } else {
      ops.push({ kind: "add", text: lineAt(head, j) });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "remove", text: lineAt(base, i) });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: lineAt(head, j) });
    j += 1;
  }
  return ops;
}

const PREFIX: Record<DiffOp["kind"], string> = {
  context: " ",
  add: "+",
  remove: "-",
};

/** Runs of changes closer than twice the context window share one hunk. */
export function buildHunks(ops: readonly DiffOp[]): DiffHunk[] {
  // The old/new-side line number each operation starts at.
  const baseLineAt: number[] = [];
  const headLineAt: number[] = [];
  let baseLine = 1;
  let headLine = 1;
  const changeIndexes: number[] = [];
  ops.forEach((op, index) => {
    baseLineAt.push(baseLine);
    headLineAt.push(headLine);
    if (op.kind !== "add") {
      baseLine += 1;
    }
    if (op.kind !== "remove") {
      headLine += 1;
    }
    if (op.kind !== "context") {
      changeIndexes.push(index);
    }
  });

  if (changeIndexes.length === 0) {
    return [];
  }

  // Cluster changes that are close enough to share a hunk.
  const clusters: Array<{ first: number; last: number }> = [];
  for (const index of changeIndexes) {
    const current = clusters[clusters.length - 1];
    if (current !== undefined && index - current.last <= CONTEXT_LINES * 2) {
      current.last = index;
    } else {
      clusters.push({ first: index, last: index });
    }
  }

  return clusters.map((cluster) => {
    const from = Math.max(0, cluster.first - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, cluster.last + CONTEXT_LINES);
    const lines: string[] = [];
    let baseCount = 0;
    let headCount = 0;
    for (let index = from; index <= to; index += 1) {
      const op = ops[index];
      if (op === undefined) {
        continue;
      }
      lines.push(`${PREFIX[op.kind]}${op.text}`);
      if (op.kind !== "add") {
        baseCount += 1;
      }
      if (op.kind !== "remove") {
        headCount += 1;
      }
    }
    // git writes a start of 0 for an empty side (a new or deleted file).
    return {
      baseStart: baseCount === 0 ? 0 : (baseLineAt[from] ?? 1),
      baseCount,
      headStart: headCount === 0 ? 0 : (headLineAt[from] ?? 1),
      headCount,
      lines,
    };
  });
}

function renderHunk(hunk: DiffHunk): string {
  return [
    `@@ -${hunk.baseStart},${hunk.baseCount} +${hunk.headStart},${hunk.headCount} @@`,
    ...hunk.lines,
  ].join("\n");
}

/** The per-file `patch` as GitHub's "list pull request files" API returns it: hunks only. */
export function buildPatch(baseText: string | undefined, headText: string, path: string): string {
  const hunks = buildHunks(
    diffOps(baseText === undefined ? [] : toLines(baseText, path), toLines(headText, path)),
  );
  return hunks.map(renderHunk).join("\n");
}

/** The git blob SHA of a file's contents, as git itself computes it. */
function blobSha(text: string): string {
  const body = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest("hex");
}

/** One file's entry in the unified diff, headers and all. */
export function buildFileDiff(
  path: string,
  baseText: string | undefined,
  headText: string,
): string {
  const added = baseText === undefined;
  const baseBlob = added ? "0000000" : blobSha(baseText).slice(0, 7);
  const headBlob = blobSha(headText).slice(0, 7);
  const header = [
    `diff --git a/${path} b/${path}`,
    ...(added ? ["new file mode 100644"] : []),
    `index ${baseBlob}..${headBlob}${added ? "" : " 100644"}`,
    added ? "--- /dev/null" : `--- a/${path}`,
    `+++ b/${path}`,
  ];
  return [...header, buildPatch(baseText, headText, path)].join("\n");
}
