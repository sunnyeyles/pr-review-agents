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
 */
import type {
  AnnotationLevel,
  CheckRunAnnotation,
  CheckRunConclusion,
  CheckRunOutput,
} from "@pr-review/github";
import type { ReviewFinding } from "@pr-review/schemas";

import type { AgentFailure } from "./review-graph.js";
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
 * The lens name in prose. Agent names are the finding categories; an
 * unrecognised name falls through verbatim.
 */
function lensLabel(agent: string): string {
  return (categoryLabels as Record<string, string | undefined>)[agent] ?? agent;
}

/**
 * The partial-failure notes for the summary: which lenses did not
 * complete. Names only — failure error strings are internal detail and
 * never reach GitHub (they are logged as agent.failed instead).
 */
function failureNotes(agentFailures: readonly AgentFailure[]): string[] {
  return agentFailures.map(
    (failure) =>
      `> **Note:** The ${lensLabel(failure.agent)} review did not complete, so its findings are missing from this run.`,
  );
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
  const count = findings.length;
  const title = count === 1 ? "1 finding" : `${count} findings`;
  const summary = [
    `**${title}**`,
    "",
    ...ordered.map(summarise),
    ...failureNotes(agentFailures),
  ].join("\n\n");

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
