/**
 * The human-readable side of an evaluation run.
 *
 * Pass/fail is what the command exits on, but a quality suite is only
 * useful if a failure can be read: which findings the reviewer
 * actually produced, how much context it went and fetched, and what it
 * cost. That is what this prints under each fixture.
 */
import type { CapturedLogEvent } from "@pr-review/logging";

import { describeFindings } from "./expectations.js";
import type { FixtureReview } from "./run-fixture-review.js";

/** The four token counters, summed across a run's completed units. */
const TOKEN_COUNTERS = [
  "inputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "outputTokens",
] as const;

type TokenTotals = Record<(typeof TOKEN_COUNTERS)[number], number>;

function tokensFrom(events: readonly CapturedLogEvent[]): TokenTotals {
  const totals: TokenTotals = {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  };
  for (const entry of events) {
    if (entry.event !== "agent.completed" && entry.event !== "synthesis.completed") {
      continue;
    }
    for (const counter of TOKEN_COUNTERS) {
      const value = entry[counter];
      totals[counter] += typeof value === "number" ? value : 0;
    }
  }
  return totals;
}

/** The share of input tokens the prompt cache served. */
function cacheHitRate(usage: TokenTotals): string {
  const total =
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  if (total === 0) {
    return "n/a";
  }
  return `${Math.round((usage.cacheReadInputTokens / total) * 100)}%`;
}

/** Groups the agents' repository reads into a one-line summary. */
function toolSummary(review: FixtureReview): string {
  const counts = new Map<string, number>();
  for (const call of review.calls) {
    counts.set(call.method, (counts.get(call.method) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return "none";
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([method, count]) => `${method} x${count}`)
    .join(", ");
}

/** One fixture's review, rendered as a block for the run report. */
export function formatReviewReport(review: FixtureReview): string {
  const { result, fixture } = review;
  const usage = tokensFrom(review.events);
  const failures =
    result.agentFailures.length === 0
      ? "none"
      : result.agentFailures.map((failure) => failure.agent).join(", ");

  return [
    `${fixture.name} — ${fixture.title}`,
    `  pull request:  ${fixture.context.owner}/${fixture.context.repo}#${fixture.pullRequest.number} ` +
      `(${fixture.changedFiles.length} changed files)`,
    `  agents:        ${result.candidates.length} candidate finding(s), failed: ${failures}`,
    `  synthesis:     ${result.synthesisOutcome} -> ${result.synthesisedCandidateCount} finding(s)` +
      (result.synthesisError === undefined ? "" : ` (${result.synthesisError})`),
    `  validated:     ${result.findings.length} finding(s), check run conclusion "${review.rendered.conclusion}"`,
    `  repository reads: ${toolSummary(review)}`,
    `  tokens:        ${usage.inputTokens} in / ${usage.outputTokens} out, ${Math.round(review.durationMs / 1000)}s`,
    `  prompt cache:  ${usage.cacheCreationInputTokens} written / ` +
      `${usage.cacheReadInputTokens} read (${cacheHitRate(usage)} of input served from cache)`,
    describeFindings(result.findings),
  ].join("\n");
}

/** The whole run's report, printed once at the end. */
export function formatRunReport(blocks: readonly string[]): string {
  return ["", "Evaluation run report", "=====================", "", ...blocks, ""].join(
    "\n\n",
  );
}
