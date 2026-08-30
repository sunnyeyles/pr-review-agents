/**
 * Renders validated findings into a pull request review: a body, and
 * one inline comment per line-anchored finding. Pure — the caller owns
 * the GitHub API call.
 *
 * Why a review as well as a check run: a check annotation cannot be
 * replied to or resolved. A review comment is a thread, so a finding
 * becomes something a reader answers and ticks off rather than a
 * notice they scroll past.
 *
 * Anchoring is already settled upstream. validateFindings drops any
 * finding whose line is not an added line of the diff, which is
 * exactly GitHub's condition for accepting an inline comment — so
 * every surviving line-anchored finding is a valid anchor, and the
 * ones without a line are file-level and carried in the body.
 */
import type { ReviewComment } from "@pr-review/github";
import type { ReviewFinding } from "@pr-review/schemas";

import {
  failureNotes,
  findingCountLabel,
  heading,
  summarise,
} from "./finding-format.js";
import type { AgentFailure } from "./review-graph.js";
import { compareFindingStrength } from "./validate-findings.js";

export interface RenderedReview {
  body: string;
  comments: ReviewComment[];
}

/** One finding as the body of its own inline comment. */
function commentBody(finding: ReviewFinding): string {
  const lines = [`**${heading(finding)}**`, "", finding.explanation];
  if (finding.suggestedFix !== undefined) {
    lines.push("", `**Suggested fix:** ${finding.suggestedFix}`);
  }
  return lines.join("\n");
}

/**
 * Builds the review payload, or undefined when there is nothing worth
 * posting — no findings means the check run's "No issues found" is the
 * whole story, and an empty review would be noise on every clean pull
 * request.
 */
export function renderReview(
  findings: readonly ReviewFinding[],
  agentFailures: readonly AgentFailure[] = [],
): RenderedReview | undefined {
  if (findings.length === 0) {
    return undefined;
  }

  const ordered = [...findings].sort(compareFindingStrength);
  const comments: ReviewComment[] = [];
  const fileLevel: ReviewFinding[] = [];

  for (const finding of ordered) {
    if (finding.line === undefined) {
      fileLevel.push(finding);
      continue;
    }
    comments.push({
      path: finding.file,
      line: finding.line,
      body: commentBody(finding),
    });
  }

  const sections = [`**AI PR Review — ${findingCountLabel(findings.length)}**`];
  if (fileLevel.length > 0) {
    sections.push(
      "These findings apply to a file rather than a line:",
      ...fileLevel.map(summarise),
    );
  }
  sections.push(...failureNotes(agentFailures));

  return { body: sections.join("\n\n"), comments };
}
