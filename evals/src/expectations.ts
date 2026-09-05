/**
 * What each fixture must produce: category and location, never wording.
 * Locations anchor to source markers, which must match exactly one line.
 */
import type { FindingCategory, ReviewFinding } from "@pr-review/schemas";

import type { LoadedFixture } from "./fixture.js";
import type { FixtureReview } from "./run-fixture-review.js";

/**
 * A region of one changed file, from `startMarker` to `endMarker` or the
 * end of the file. A finding with no line counts as pointing at the file.
 */
interface FindingAnchor {
  file: string;
  startMarker: string;
  endMarker?: string;
}

export type FixtureExpectation =
  | {
      kind: "finding";
      description: string;
      category: FindingCategory;
      /** The finding must land inside at least one of these regions. */
      anchors: FindingAnchor[];
    }
  | { kind: "no-findings"; description: string }
  | { kind: "agents-completed"; description: string };

/** The judgement of one expectation against one fixture review. */
interface ExpectationOutcome {
  passed: boolean;
  /** Why it passed or failed, including the findings that were produced. */
  detail: string;
}

interface ResolvedAnchor {
  file: string;
  from: number;
  to: number;
}

function lineOf(lines: readonly string[], marker: string, file: string): number {
  const matches: number[] = [];
  lines.forEach((line, index) => {
    if (line.includes(marker)) {
      matches.push(index + 1);
    }
  });
  const first = matches[0];
  if (matches.length !== 1 || first === undefined) {
    throw new Error(
      `expectation anchor "${marker}" matches ${matches.length} lines of ${file}; ` +
        "it must match exactly one — update the anchor or the fixture",
    );
  }
  return first;
}

/** Turns an anchor's markers into a line range in the fixture's file. */
export function resolveAnchor(
  fixture: LoadedFixture,
  anchor: FindingAnchor,
): ResolvedAnchor {
  const contents = fixture.headFiles.get(anchor.file);
  if (contents === undefined) {
    throw new Error(
      `expectation anchors ${anchor.file}, which fixture ${fixture.name} does not contain`,
    );
  }
  if (!fixture.changedFiles.some((file) => file.filename === anchor.file)) {
    throw new Error(
      `expectation anchors ${anchor.file}, which fixture ${fixture.name}'s pull request does not change`,
    );
  }
  const lines = contents.split("\n");
  const from = lineOf(lines, anchor.startMarker, anchor.file);
  const to =
    anchor.endMarker === undefined
      ? lines.length
      : lineOf(lines, anchor.endMarker, anchor.file);
  return { file: anchor.file, from, to };
}

function inAnchor(finding: ReviewFinding, anchor: ResolvedAnchor): boolean {
  if (finding.file !== anchor.file) {
    return false;
  }
  // A file-level finding still points at the planted problem.
  return (
    finding.line === undefined ||
    (finding.line >= anchor.from && finding.line <= anchor.to)
  );
}

/** One finding rendered for a failure message. */
function describeFinding(finding: ReviewFinding): string {
  const at = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return (
    `- [${finding.category}/${finding.severity}/confidence ${finding.confidence}] ` +
    `${at} — ${finding.title}`
  );
}

/** The findings of a review, rendered for a failure message. */
export function describeFindings(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) {
    return "  (no findings)";
  }
  return findings.map((finding) => `  ${describeFinding(finding)}`).join("\n");
}

/** Judges one expectation against one fixture review. */
export function evaluateExpectation(
  review: FixtureReview,
  expectation: FixtureExpectation,
): ExpectationOutcome {
  const { findings } = review.result;
  const rendered = `The review produced ${findings.length} finding(s):\n${describeFindings(findings)}`;

  if (expectation.kind === "agents-completed") {
    const failures = review.result.agentFailures;
    return {
      passed: failures.length === 0,
      detail:
        failures.length === 0
          ? "every review agent completed"
          : `these agents failed:\n${failures
              .map((failure) => `  - ${failure.agent}: ${failure.error}`)
              .join("\n")}`,
    };
  }

  if (expectation.kind === "no-findings") {
    return {
      passed: findings.length === 0,
      detail:
        findings.length === 0
          ? "the review came back clean, as it must for correct code"
          : `${rendered}\n\nEvery finding above is a false positive: this fixture is correct code.`,
    };
  }

  const anchors = expectation.anchors.map((anchor) =>
    resolveAnchor(review.fixture, anchor),
  );
  const matched = findings.filter(
    (finding) =>
      finding.category === expectation.category &&
      anchors.some((anchor) => inAnchor(finding, anchor)),
  );
  if (matched.length > 0) {
    return {
      passed: true,
      detail: `matched:\n${describeFindings(matched)}`,
    };
  }

  const where = anchors
    .map((anchor) => `  ${anchor.file}:${anchor.from}-${anchor.to}`)
    .join("\n");
  return {
    passed: false,
    detail:
      `No ${expectation.category} finding landed on the planted problem.\n` +
      `Expected a ${expectation.category} finding within:\n${where}\n\n${rendered}`,
  };
}
