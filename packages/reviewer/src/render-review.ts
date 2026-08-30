/**
 * Renders validated findings into a review body plus one inline comment
 * per line-anchored finding; the caller owns the API call. Anchoring is
 * settled upstream: validateFindings already drops findings that are not
 * on an added line, which is GitHub's own condition for a comment.
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

/** undefined when there is nothing worth posting; a clean PR gets no review. */
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
