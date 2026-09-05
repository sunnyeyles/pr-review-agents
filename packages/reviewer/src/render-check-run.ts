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
import type { SkippedAgent } from "@pr-review/ai";
import { categoryLabel, type ReviewFinding } from "@pr-review/schemas";

import {
  countLabel,
  failureNotes,
  pathList,
  skipNotes,
  summarise,
} from "./finding-format.js";
import type { AgentFailure } from "./review-graph.js";
import { compareFindingStrength } from "./validate-findings.js";

/** The GitHub checks API accepts at most 50 annotations per request. */
export const MAX_ANNOTATIONS_PER_REQUEST = 50;

/** Enough to recognise a pull request; a bump of 300 files would bury the reason. */
const MAX_LISTED_CHANGED_FILES = 10;

export interface RenderedCheckRun {
  conclusion: CheckRunConclusion;
  output: CheckRunOutput;
}

interface RenderCheckRunOptions {
  /**
   * Whether line-anchored findings also become inline annotations.
   * Defaults to true; set false once the review comments carry them.
   */
  annotate?: boolean | undefined;
  /** Agents whose paths no changed file matched, named in the summary. */
  skippedAgents?: readonly SkippedAgent[] | undefined;
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
 * Names the files nobody reviewed, so the reason a gate held is legible
 * without opening the pull request. Empty for a pull request that
 * changed nothing, like the other note builders.
 */
function changedFilesNote(changedFiles: readonly string[]): string[] {
  if (changedFiles.length === 0) {
    return [];
  }
  const listed = pathList(changedFiles.slice(0, MAX_LISTED_CHANGED_FILES));
  const remaining = changedFiles.length - MAX_LISTED_CHANGED_FILES;
  return [
    remaining > 0
      ? `Changed: ${listed}, and ${remaining} more.`
      : `Changed: ${listed}.`,
  ];
}

/**
 * The check run for a pull request no agent's paths matched. Never
 * "success": nothing was reviewed, and a green check saying so is
 * indistinguishable from a clean bill of health.
 */
export function renderNoAgentMatched(
  skippedAgents: readonly SkippedAgent[],
  changedFiles: readonly string[],
): RenderedCheckRun {
  return {
    conclusion: "neutral",
    output: {
      title: "No agent reviewed this pull request",
      summary: [
        `None of the ${countLabel(skippedAgents.length, "configured agent")} matched the ${countLabel(changedFiles.length, "changed file")}, so this pull request was not reviewed.`,
        ...skippedAgents.map(
          (skipped) =>
            `- ${categoryLabel(skipped.agent)} — waiting on ${pathList(skipped.paths)}`,
        ),
        ...changedFilesNote(changedFiles),
      ].join("\n\n"),
    },
  };
}

/** Findings render strongest first; line-anchored ones also become annotations. */
export function renderCheckRun(
  findings: readonly ReviewFinding[],
  agentFailures: readonly AgentFailure[] = [],
  options: RenderCheckRunOptions = {},
): RenderedCheckRun {
  const skipped = skipNotes(options.skippedAgents ?? []);
  if (findings.length === 0) {
    return {
      conclusion: agentFailures.length === 0 ? "success" : "neutral",
      output: {
        title: "No issues found",
        summary: [
          "The AI review found no issues in this pull request.",
          ...failureNotes(agentFailures),
          ...skipped,
        ].join("\n\n"),
      },
    };
  }

  const ordered = [...findings].sort(compareFindingStrength);
  const title = countLabel(findings.length, "finding");
  const summary = [
    `**${title}**`,
    "",
    ...ordered.map(summarise),
    ...failureNotes(agentFailures),
    ...skipped,
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
