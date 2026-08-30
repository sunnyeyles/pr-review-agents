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

/**
 * Identifies a finding across pushes, so a re-review does not repost
 * what is already on the pull request.
 *
 * File and title, not line: a later push shifts line numbers, and the
 * same finding at a new line is still the same finding. Severity and
 * category are excluded for the same reason — a re-run that reassesses
 * either must not read as something new.
 */
export function findingKey(finding: ReviewFinding): string {
  const title = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${finding.file}|${title}`;
}

/**
 * The marker carrying findingKey inside a published comment. An HTML
 * comment renders as nothing, so the identity travels with the comment
 * itself and no state has to be stored anywhere else.
 */
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
 * Builds the review payload, or undefined when there is nothing worth
 * posting — no findings means the check run's "No issues found" is the
 * whole story, and an empty review would be noise on every clean pull
 * request. A push whose findings were all reported on an earlier
 * commit is the same case: the existing threads still stand.
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
