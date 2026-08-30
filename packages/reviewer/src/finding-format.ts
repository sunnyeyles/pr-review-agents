/**
 * How a finding reads once it leaves the pipeline.
 *
 * Two surfaces render the same findings — the check run and the pull
 * request review — and they must describe a finding identically, so
 * the prose lives here rather than in either renderer.
 */
import type { ReviewFinding } from "@pr-review/schemas";

import type { AgentFailure } from "./review-graph.js";

export const categoryLabels: Record<ReviewFinding["category"], string> = {
  correctness: "Correctness",
  security: "Security",
  architecture: "Architecture",
};

/** `file` alone, or `file:line` when the finding is line-anchored. */
export function location(finding: ReviewFinding): string {
  return finding.line === undefined
    ? finding.file
    : `${finding.file}:${finding.line}`;
}

/** The finding's heading: severity, lens, and title. */
export function heading(finding: ReviewFinding): string {
  return `${finding.severity.toUpperCase()} — ${categoryLabels[finding.category]}: ${finding.title}`;
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

/**
 * The lens name in prose. Agent names are the finding categories; an
 * unrecognised name falls through verbatim.
 */
export function lensLabel(agent: string): string {
  return (categoryLabels as Record<string, string | undefined>)[agent] ?? agent;
}

/**
 * Which lenses did not complete. Names only — failure error strings
 * are internal detail and never reach GitHub (they are logged as
 * agent.failed instead).
 */
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
