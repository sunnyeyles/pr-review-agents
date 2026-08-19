/**
 * Unified-diff construction for the evaluation fixtures.
 *
 * A fixture stores whole files, not diffs: `repo/` is the tree at the
 * head SHA and `base/` holds the previous contents of the files the
 * fixture's pull request modifies. The diff the agents review — and,
 * crucially, the per-file `patch` the deterministic validation chain
 * anchors findings against (@pr-review/reviewer's diff-lines.ts) — is
 * generated from those files here.
 *
 * Generating rather than hand-writing the patches is deliberate: a
 * hand-written hunk header with a line number one off would silently
 * drop a correct finding during validation and fail an evaluation for
 * a reason that has nothing to do with review quality.
 *
 * The line diff is a plain longest-common-subsequence walk, grouped
 * into hunks with three lines of context — the same shape git emits.
 * Fixture files are small, so the O(n*m) table costs nothing.
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
 * Splits file text into lines, dropping the single trailing newline.
 * Fixture files must end with one — a file that does not would need a
 * "\ No newline at end of file" marker to diff faithfully, and it is
 * cheaper to reject it than to emit a diff nobody meant to write.
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

/**
 * The line-level diff of two files as a flat operation list, in
 * new-file order (a removed line appears before the added line that
 * replaced it).
 */
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

/**
 * Groups diff operations into hunks. Runs of changes closer together
 * than twice the context window share one hunk, so the output looks
 * like the diff a reviewer sees on the pull request.
 */
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

/**
 * The per-file `patch` string, in the shape GitHub's "list pull
 * request files" API returns it: hunks only, no `diff --git` header.
 * This is what the deterministic validation chain parses to decide
 * whether a finding's line is an added line.
 */
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

/**
 * One file's entry in the pull request's unified diff, headers and
 * all — the `.diff` GitHub serves for a pull request is these
 * concatenated.
 */
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
