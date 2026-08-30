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
import {
  compareFindingStrength,
  normaliseTitle,
} from "./validate-findings.js";

export interface RenderedReview {
  body: string;
  comments: ReviewComment[];
}

/**
 * Identifies a finding across pushes. File and title, not line: a later
 * push shifts line numbers, and the same finding at a new line is still
 * the same finding.
 */
export function findingKey(finding: ReviewFinding): string {
  return `${finding.file}|${normaliseTitle(finding.title)}`;
}

/** Carries findingKey inside a comment; an HTML comment renders as nothing. */
export function findingMarker(finding: ReviewFinding): string {
  return `<!-- pr-review-finding: ${findingKey(finding)} -->`;
}

const MARKER = /<!-- pr-review-finding: (.*?) -->/;

/** The finding keys already posted as comments on a pull request. */
export function postedFindingKeys(
  comments: readonly { body: string }[],
): Set<string> {
  const keys = new Set<string>();
  for (const comment of comments) {
    const match = MARKER.exec(comment.body);
    if (match?.[1] !== undefined) {
      keys.add(match[1]);
    }
  }
  return keys;
}

/** One finding as the body of its own inline comment. */
function commentBody(finding: ReviewFinding): string {
  const lines = [`**${heading(finding)}**`, "", finding.explanation];
  if (finding.suggestedFix !== undefined) {
    lines.push("", `**Suggested fix:** ${finding.suggestedFix}`);
  }
  lines.push("", findingMarker(finding));
  return lines.join("\n");
}

/**
 * undefined when there is nothing worth posting; a clean PR gets no
 * review, and neither does one whose findings all stand as comments
 * from an earlier commit.
 */
export function renderReview(
  findings: readonly ReviewFinding[],
  agentFailures: readonly AgentFailure[] = [],
  alreadyPosted: ReadonlySet<string> = new Set(),
): RenderedReview | undefined {
  const fresh = findings.filter(
    (finding) => !alreadyPosted.has(findingKey(finding)),
  );
  if (fresh.length === 0) {
    return undefined;
  }

  const ordered = [...fresh].sort(compareFindingStrength);
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

  const sections = [`**AI PR Review — ${findingCountLabel(fresh.length)}**`];
  if (fresh.length < findings.length) {
    sections.push(
      `${findings.length - fresh.length} further finding(s) were reported on an earlier commit and are not repeated here.`,
    );
  }
  if (fileLevel.length > 0) {
    sections.push(
      "These findings apply to a file rather than a line:",
      ...fileLevel.map(summarise),
    );
  }
  sections.push(...failureNotes(agentFailures));

  return { body: sections.join("\n\n"), comments };
}
