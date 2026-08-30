/**
 * Renders validated findings into the completed "AI PR Review" check
 * run payload. Pure: the caller owns the actual GitHub API call.
 *
 * - No findings: a clean "No issues found" run with conclusion
 *   "success".
 * - Findings: conclusion "neutral" (the review is advisory; the app
 *   must not block or approve merges), a summary listing every finding
 *   strongest first, and inline annotations for line-anchored findings.
 * - Agent failures (partial failure): the summary notes which
 *   lens did not complete — by name only, error details stay in the
 *   logs — and the conclusion is "neutral" even with zero findings,
 *   because an incomplete review must not publish a clean bill of
 *   health.
 *
 * The summary is complete on its own. When the pull request review
 * carries the findings inline, the caller suppresses the annotations
 * so the same text does not appear twice against the same line, and
 * the check run stays the durable single-page record.
 */
import type {
  AnnotationLevel,
  CheckRunAnnotation,
  CheckRunConclusion,
  CheckRunOutput,
} from "@pr-review/github";
import type { ReviewFinding } from "@pr-review/schemas";

import {
  failureNotes,
  findingCountLabel,
  summarise,
} from "./finding-format.js";
import type { AgentFailure } from "./review-graph.js";
import { compareFindingStrength } from "./validate-findings.js";

/** The GitHub checks API accepts at most 50 annotations per request. */
export const MAX_ANNOTATIONS_PER_REQUEST = 50;

export interface RenderedCheckRun {
  conclusion: CheckRunConclusion;
  output: CheckRunOutput;
}

export interface RenderCheckRunOptions {
  /**
   * Whether line-anchored findings also become inline annotations.
   * Defaults to true; set false once the review comments carry them.
   */
  annotate?: boolean | undefined;
}

const annotationLevelBySeverity: Record<
  ReviewFinding["severity"],
  AnnotationLevel
> = {
  low: "notice",
  medium: "warning",
  high: "failure",
};

function annotate(finding: ReviewFinding, line: number): CheckRunAnnotation {
  const message =
    finding.suggestedFix === undefined
      ? finding.explanation
      : `${finding.explanation}\n\nSuggested fix: ${finding.suggestedFix}`;
  return {
    path: finding.file,
    start_line: line,
    end_line: line,
    annotation_level: annotationLevelBySeverity[finding.severity],
    message,
    title: finding.title,
  };
}

/**
 * Builds the completed check-run payload for a set of validated
 * findings and the lenses that failed to produce any. Findings are
 * rendered strongest first (severity rank, then confidence);
 * line-anchored findings additionally become inline annotations,
 * capped at MAX_ANNOTATIONS_PER_REQUEST.
 */
export function renderCheckRun(
  findings: readonly ReviewFinding[],
  agentFailures: readonly AgentFailure[] = [],
  options: RenderCheckRunOptions = {},
): RenderedCheckRun {
  if (findings.length === 0) {
    return {
      conclusion: agentFailures.length === 0 ? "success" : "neutral",
      output: {
        title: "No issues found",
        summary: [
          "The AI review found no issues in this pull request.",
          ...failureNotes(agentFailures),
        ].join("\n\n"),
      },
    };
  }

  const ordered = [...findings].sort(compareFindingStrength);
  const title = findingCountLabel(findings.length);
  const summary = [
    `**${title}**`,
    "",
    ...ordered.map(summarise),
    ...failureNotes(agentFailures),
  ].join("\n\n");

  const output: CheckRunOutput = { title, summary };

  if (options.annotate ?? true) {
    const annotations: CheckRunAnnotation[] = [];
    for (const finding of ordered) {
      if (annotations.length >= MAX_ANNOTATIONS_PER_REQUEST) {
        break;
      }
      if (finding.line !== undefined) {
        annotations.push(annotate(finding, finding.line));
      }
    }
    if (annotations.length > 0) {
      output.annotations = annotations;
    }
  }

  return { conclusion: "neutral", output };
}
