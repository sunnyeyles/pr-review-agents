/**
 * Renders validated findings into the check-run payload; the caller owns
 * the API call. The conclusion is never "failure" — the review is
 * advisory — and never "success" when an agent failed. The summary is
 * complete on its own, so the caller suppresses the annotations when the
 * review already carries the same findings inline.
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

/** Findings render strongest first; line-anchored ones also become annotations. */
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
