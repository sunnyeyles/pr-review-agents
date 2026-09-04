/**
 * The deterministic validation chain. Every candidate must survive, in
 * order: schema, category, changed file, added line, confidence,
 * duplicate removal, then the MAX_FINDINGS cap. Dedupe runs first so
 * duplicates cannot consume cap slots and leave the review short.
 */
import type { ChangedFile } from "@pr-review/github";
import { wellFormedFindings, type ReviewFinding } from "@pr-review/schemas";

import { buildChangedLineIndex } from "./diff-lines.js";

/** Findings with confidence below this threshold are dropped. */
export const CONFIDENCE_THRESHOLD = 0.7;

/** At most this many findings are published per review. */
export const MAX_FINDINGS = 10;

const severityRank: Record<ReviewFinding["severity"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Orders findings strongest first: severity rank, then confidence,
 * both descending. Ties preserve the caller's order when used with a
 * stable sort (Array.prototype.sort is stable).
 */
export function compareFindingStrength(
  a: ReviewFinding,
  b: ReviewFinding,
): number {
  const severityDelta = severityRank[b.severity] - severityRank[a.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }
  return b.confidence - a.confidence;
}

/** Titles compare on words alone, so punctuation and case cannot split a pair. */
export function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The two keys under which a finding can collide with an earlier one. */
function duplicateKeys(finding: ReviewFinding): [string, string] {
  return [
    `anchor:${finding.file} ${finding.line ?? "file-level"} ${finding.category}`,
    `title:${finding.file} ${normaliseTitle(finding.title)}`,
  ];
}

/**
 * Runs raw candidate findings through the deterministic validation
 * chain against the PR's changed files. Pure: no I/O, no mutation of
 * its inputs. Returns the surviving findings, strongest first.
 */
export function validateFindings(
  candidates: readonly unknown[],
  changedFiles: readonly ChangedFile[],
  allowedCategories: readonly string[],
): ReviewFinding[] {
  // 1. Schema validity.
  const wellFormed = wellFormedFindings(candidates);

  // 2. Category is one the run's agents own. The schema cannot check
  // this: the agent set is configurable and known only at runtime.
  const allowed = new Set(allowedCategories);
  const inCategory = wellFormed.filter((finding) =>
    allowed.has(finding.category),
  );

  // 3 + 4. File exists in the PR; line (when present) is an added line
  // in that file's diff.
  const changedLines = buildChangedLineIndex(changedFiles);
  const anchored = inCategory.filter((finding) => {
    const lines = changedLines.get(finding.file);
    if (lines === undefined) {
      return false;
    }
    return finding.line === undefined || lines.has(finding.line);
  });

  // 5. Confidence threshold.
  const confident = anchored.filter(
    (finding) => finding.confidence >= CONFIDENCE_THRESHOLD,
  );

  // 6. Duplicate removal. Sorted first, so the strongest of each group
  // is the one that survives.
  const strongestFirst = [...confident].sort(compareFindingStrength);
  const seen = new Set<string>();
  const distinct: ReviewFinding[] = [];
  for (const finding of strongestFirst) {
    const keys = duplicateKeys(finding);
    if (keys.some((key) => seen.has(key))) {
      continue;
    }
    for (const key of keys) {
      seen.add(key);
    }
    distinct.push(finding);
  }

  // 7. Cap at MAX_FINDINGS, keeping the strongest.
  return distinct.slice(0, MAX_FINDINGS);
}
