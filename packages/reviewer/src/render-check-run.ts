/**
 * Renders validated findings into the completed "AI PR Review" check
 * run payload. Pure: the worker owns the actual GitHub API call.
 *
 * - No findings: a clean "No issues found" run with conclusion
 *   "success".
 * - Findings: conclusion "neutral" (the review is advisory; the app
 *   must not block or approve merges), a summary listing every finding
 *   strongest first, and inline annotations for line-anchored findings.
 */
import type {
  AnnotationLevel,
  CheckRunAnnotation,
  CheckRunConclusion,
  CheckRunOutput,
} from "@pr-review/github";
import type { ReviewFinding } from "@pr-review/schemas";

import { compareFindingStrength } from "./validate-findings.js";

/** The GitHub checks API accepts at most 50 annotations per request. */
export const MAX_ANNOTATIONS_PER_REQUEST = 50;

export interface RenderedCheckRun {
  conclusion: CheckRunConclusion;
  output: CheckRunOutput;
}

const annotationLevelBySeverity: Record<
  ReviewFinding["severity"],
  AnnotationLevel
> = {
  low: "notice",
  medium: "warning",
  high: "failure",
};

const categoryLabels: Record<ReviewFinding["category"], string> = {
  correctness: "Correctness",
  security: "Security",
  architecture: "Architecture",
};

function location(finding: ReviewFinding): string {
  return finding.line === undefined
    ? finding.file
    : `${finding.file}:${finding.line}`;
}

function summarise(finding: ReviewFinding): string {
  const lines = [
    `### ${finding.severity.toUpperCase()} — ${categoryLabels[finding.category]}: ${finding.title}`,
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
 * findings. Findings are rendered strongest first (severity rank, then
 * confidence); line-anchored findings additionally become inline
 * annotations, capped at MAX_ANNOTATIONS_PER_REQUEST.
 */
export function renderCheckRun(
  findings: readonly ReviewFinding[],
): RenderedCheckRun {
  if (findings.length === 0) {
    return {
      conclusion: "success",
      output: {
        title: "No issues found",
        summary: "The AI review found no issues in this pull request.",
      },
    };
  }

  const ordered = [...findings].sort(compareFindingStrength);
  const count = findings.length;
  const title = count === 1 ? "1 finding" : `${count} findings`;
  const summary = [`**${title}**`, "", ...ordered.map(summarise)].join("\n\n");

  const annotations: CheckRunAnnotation[] = [];
  for (const finding of ordered) {
    if (annotations.length >= MAX_ANNOTATIONS_PER_REQUEST) {
      break;
    }
    if (finding.line !== undefined) {
      annotations.push(annotate(finding, finding.line));
    }
  }

  const output: CheckRunOutput = { title, summary };
  if (annotations.length > 0) {
    output.annotations = annotations;
  }

  return { conclusion: "neutral", output };
}
