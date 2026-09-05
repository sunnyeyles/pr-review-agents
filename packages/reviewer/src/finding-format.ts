/**
 * How a finding reads once it leaves the pipeline. Shared so the check
 * run and the review describe a finding identically.
 */
import type { SkippedAgent } from "@pr-review/ai";
import { categoryLabel, type ReviewFinding } from "@pr-review/schemas";

import type { AgentFailure } from "./review-graph.js";

/** `file` alone, or `file:line` when the finding is line-anchored. */
export function location(finding: ReviewFinding): string {
  return finding.line === undefined
    ? finding.file
    : `${finding.file}:${finding.line}`;
}

/** The finding's heading: severity, agent, and title. */
export function heading(finding: ReviewFinding): string {
  return `${finding.severity.toUpperCase()} — ${categoryLabel(finding.category)}: ${finding.title}`;
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

/** Which agents did not complete. Names only; error strings never reach GitHub. */
export function failureNotes(
  agentFailures: readonly AgentFailure[],
): string[] {
  return agentFailures.map(
    (failure) =>
      `> **Note:** The ${categoryLabel(failure.agent)} review did not complete, so its findings are missing from this run.`,
  );
}

/** Paths — changed files or an agent's patterns — as inline code spans. */
export function pathList(paths: readonly string[]): string {
  return paths.map((path) => `\`${path}\``).join(", ");
}

/**
 * Which agents sat this pull request out. A skipped agent is intended,
 * unlike a failed one, but it still has to be said: a review nobody can
 * see was narrowed is indistinguishable from a clean one.
 */
export function skipNotes(skippedAgents: readonly SkippedAgent[]): string[] {
  return skippedAgents.map(
    (skipped) =>
      `> **Note:** The ${categoryLabel(skipped.agent)} review did not run: no changed file matched its paths (${pathList(skipped.paths)}).`,
  );
}

/** "1 finding" / "3 agents". Pluralised by adding an "s". */
export function countLabel(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}
