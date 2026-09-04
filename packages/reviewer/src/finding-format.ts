/**
 * How a finding reads once it leaves the pipeline. Shared so the check
 * run and the review describe a finding identically.
 */
import { categoryLabel, type ReviewFinding } from "@pr-review/schemas";

import type { AgentFailure } from "./review-graph.js";

/** `file` alone, or `file:line` when the finding is line-anchored. */
export function location(finding: ReviewFinding): string {
  return finding.line === undefined
    ? finding.file
    : `${finding.file}:${finding.line}`;
}

/** The finding's heading: severity, lens, and title. */
export function heading(finding: ReviewFinding): string {
  return `${finding.severity.toUpperCase()} — ${lensLabel(finding.category)}: ${finding.title}`;
}

/** A finding as a standalone Markdown block, location included. */
export function summarise(finding: ReviewFinding): string {
  const lines = [
    `### ${heading(finding)}`,
    "",
    `\`${location(finding)}\``,
    "",
    finding.explanation,
  ];
  if (finding.suggestedFix !== undefined) {
    lines.push("", `**Suggested fix:** ${finding.suggestedFix}`);
  }
  return lines.join("\n");
}

/** The lens name in prose, derived from its category slug. */
export function lensLabel(agent: string): string {
  return categoryLabel(agent);
}

/** Which lenses did not complete. Names only; error strings never reach GitHub. */
export function failureNotes(
  agentFailures: readonly AgentFailure[],
): string[] {
  return agentFailures.map(
    (failure) =>
      `> **Note:** The ${lensLabel(failure.agent)} review did not complete, so its findings are missing from this run.`,
  );
}

/** "1 finding" / "N findings". */
export function findingCountLabel(count: number): string {
  return count === 1 ? "1 finding" : `${count} findings`;
}
