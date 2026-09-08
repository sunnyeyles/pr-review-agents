/**
 * Proves a proposed patch against the file it claims to edit. A patch whose
 * `expected` text does not match the head commit is discarded, never applied.
 */
import type { ChangedFile, GithubInstallationClient } from "@pr-review/github";
import type { FindingPatch, ReviewFinding } from "@pr-review/schemas";

import { buildChangedLineIndex } from "./diff-lines.js";
import { compareFindingStrength } from "./validate-findings.js";

/** At most this many files may be edited by one review. */
export const MAX_PATCHED_FILES = 5;

/** At most this many replaced lines across the whole review. */
export const MAX_PATCHED_LINES = 200;

/** One file's complete contents once every kept patch is applied. */
export interface PatchedFile {
  path: string;
  content: string;
}

/** How many patches were proposed, and how many proved to match the file. */
export interface PatchSummary {
  proposed: number;
  verified: number;
}

export interface PatchVerification {
  /** The input findings, with every unverifiable patch stripped. */
  findings: ReviewFinding[];
  files: PatchedFile[];
  patchCount: number;
  summary: PatchSummary;
}

interface VerifyPatchDeps {
  client: GithubInstallationClient;
  owner: string;
  repo: string;
  /** The commit patches are proved against and built on. */
  headSha: string;
}

/** The file split into lines, remembering whether it ended in a newline. */
interface FileText {
  lines: string[];
  trailingNewline: boolean;
}

function splitLines(content: string): FileText {
  const lines = content.split("\n");
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function joinLines(text: FileText): string {
  return text.lines.join("\n") + (text.trailingNewline ? "\n" : "");
}

/** A block quoted from a file may or may not carry its final separator. */
function withoutTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** The lines a patch replaces, or undefined when its range leaves the file. */
function rangeText(text: FileText, patch: FindingPatch): string | undefined {
  if (patch.endLine > text.lines.length) {
    return undefined;
  }
  return text.lines.slice(patch.startLine - 1, patch.endLine).join("\n");
}

function overlaps(a: FindingPatch, b: FindingPatch): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/** Whether the range touches at least one line this pull request adds. */
function touchesDiff(patch: FindingPatch, changed: ReadonlySet<number>): boolean {
  for (let line = patch.startLine; line <= patch.endLine; line += 1) {
    if (changed.has(line)) {
      return true;
    }
  }
  return false;
}

/** Descending start line, so an earlier splice cannot shift a later one. */
function applyPatches(text: FileText, patches: readonly FindingPatch[]): FileText {
  const lines = [...text.lines];
  const ordered = [...patches].sort((a, b) => b.startLine - a.startLine);
  for (const patch of ordered) {
    const replacement = withoutTrailingNewline(patch.replacement);
    lines.splice(
      patch.startLine - 1,
      patch.endLine - patch.startLine + 1,
      ...(patch.replacement === "" ? [] : replacement.split("\n")),
    );
  }
  return { lines, trailingNewline: text.trailingNewline };
}

/**
 * Reads each patched file once at the head commit. A file that cannot be read
 * is treated as unverifiable, so its patches are dropped rather than guessed at.
 */
function fileReader(deps: VerifyPatchDeps): (path: string) => Promise<FileText | undefined> {
  const cache = new Map<string, Promise<FileText | undefined>>();
  return (path) => {
    const cached = cache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const pending = deps.client
      .getFileContents({
        owner: deps.owner,
        repo: deps.repo,
        path,
        ref: deps.headSha,
      })
      .then(splitLines)
      .catch(() => undefined);
    cache.set(path, pending);
    return pending;
  };
}

/**
 * Keeps only patches that match the file byte for byte, sit inside the diff,
 * and fit the caps. Findings survive either way; only the patch is at stake.
 */
export async function verifyPatches(
  findings: readonly ReviewFinding[],
  changedFiles: readonly ChangedFile[],
  deps: VerifyPatchDeps,
): Promise<PatchVerification> {
  const changedLines = buildChangedLineIndex(changedFiles);
  const readFile = fileReader(deps);
  const kept = new Map<string, FindingPatch[]>();
  const verified = new Set<ReviewFinding>();
  let patchedLines = 0;

  for (const finding of [...findings].sort(compareFindingStrength)) {
    const { patch } = finding;
    if (patch === undefined) {
      continue;
    }

    const changed = changedLines.get(finding.file);
    if (changed === undefined || !touchesDiff(patch, changed)) {
      continue;
    }

    const lineCount = patch.endLine - patch.startLine + 1;
    const newFile = !kept.has(finding.file);
    if (newFile && kept.size >= MAX_PATCHED_FILES) {
      continue;
    }
    if (patchedLines + lineCount > MAX_PATCHED_LINES) {
      continue;
    }

    const existing = kept.get(finding.file) ?? [];
    if (existing.some((other) => overlaps(other, patch))) {
      continue;
    }

    const text = await readFile(finding.file);
    if (text === undefined) {
      continue;
    }
    const actual = rangeText(text, patch);
    if (actual === undefined || actual !== withoutTrailingNewline(patch.expected)) {
      continue;
    }

    existing.push(patch);
    kept.set(finding.file, existing);
    verified.add(finding);
    patchedLines += lineCount;
  }

  const files: PatchedFile[] = [];
  for (const [path, patches] of kept) {
    const text = await readFile(path);
    if (text !== undefined) {
      files.push({ path, content: joinLines(applyPatches(text, patches)) });
    }
  }

  return {
    findings: findings.map((finding) =>
      finding.patch === undefined || verified.has(finding)
        ? finding
        : stripPatch(finding),
    ),
    files,
    patchCount: verified.size,
    summary: {
      proposed: findings.filter((finding) => finding.patch !== undefined).length,
      verified: verified.size,
    },
  };
}

function stripPatch(finding: ReviewFinding): ReviewFinding {
  const { patch: _discarded, ...rest } = finding;
  return rest;
}
