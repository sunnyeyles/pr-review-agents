/**
 * Renders validated findings into a review body plus inline comments; the
 * caller owns the API call. validateFindings already settles anchoring.
 */
import type { SkippedAgent } from "@pr-review/ai";
import type { ReviewComment } from "@pr-review/github";
import type { ReviewFinding } from "@pr-review/schemas";

import {
  countLabel,
  failureNotes,
  heading,
  skipNotes,
  summarise,
} from "./finding-format.js";
import type { AgentFailure } from "./review-pipeline.js";
import {
  compareFindingStrength,
  normaliseTitle,
} from "./validate-findings.js";

export interface RenderedReview {
  body: string;
  comments: ReviewComment[];
}

/**
 * Identifies a finding across pushes. File and title, not line: a later push
 * shifts line numbers.
 */
function findingKey(finding: ReviewFinding): string {
  return `${finding.file}|${normaliseTitle(finding.title)}`;
}

/** Carries findingKey inside a comment; an HTML comment renders as nothing. */
export function findingMarker(finding: ReviewFinding): string {
  return `<!-- pr-review-finding: ${findingKey(finding)} -->`;
}

/** The finding marker carries no category, so the category rides its own. */
export function categoryMarker(finding: ReviewFinding): string {
  return `<!-- pr-review-category: ${finding.category} -->`;
}

const MARKER = /<!-- pr-review-finding: (.*?) -->/;
const CATEGORY_MARKER = /<!-- pr-review-category: (.*?) -->/;

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

export interface PostedFinding {
  key: string;
  file: string;
  title: string;
  category: string;
}

/** undefined for a comment predating either marker, or written by a human. */
export function parsePostedFinding(body: string): PostedFinding | undefined {
  const key = MARKER.exec(body)?.[1];
  const category = CATEGORY_MARKER.exec(body)?.[1];
  if (key === undefined || category === undefined) {
    return undefined;
  }
  const separator = key.lastIndexOf("|");
  if (separator === -1) {
    return undefined;
  }
  return {
    key,
    file: key.slice(0, separator),
    title: key.slice(separator + 1),
    category,
  };
}

/** One finding as the body of its own inline comment. */
function commentBody(finding: ReviewFinding): string {
  const lines = [`**${heading(finding)}**`, "", finding.explanation];
  if (finding.suggestedFix !== undefined) {
    lines.push("", `**Suggested fix:** ${finding.suggestedFix}`);
  }
  lines.push("", findingMarker(finding), categoryMarker(finding));
  return lines.join("\n");
}

export interface ReviewNotes {
  agentFailures: readonly AgentFailure[];
  /** Finding keys already carrying a comment from an earlier commit. */
  alreadyPosted: ReadonlySet<string>;
  skippedAgents: readonly SkippedAgent[];
}

/**
 * undefined when there is nothing worth posting: a clean PR, or one whose
 * findings all stand as comments from an earlier commit.
 */
export function renderReview(
  findings: readonly ReviewFinding[],
  {
    agentFailures = [],
    alreadyPosted = new Set(),
    skippedAgents = [],
  }: Partial<ReviewNotes> = {},
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

  const sections = [`**AI PR Review — ${countLabel(fresh.length, "finding")}**`];
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
  sections.push(...failureNotes(agentFailures), ...skipNotes(skippedAgents));

  return { body: sections.join("\n\n"), comments };
}
