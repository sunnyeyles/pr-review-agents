import type { ChangedFile } from "@pr-review/github";
import type { ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_THRESHOLD,
  MAX_FINDINGS,
  validateFindings,
} from "./validate-findings.js";

/** src/service.ts has added lines 10, 11, and 12 (line 9 is context). */
const servicePatch = [
  "@@ -9,1 +9,4 @@ export function service() {",
  " const context9 = true;",
  "+const added10 = true;",
  "+const added11 = true;",
  "+const added12 = true;",
].join("\n");

/** src/other.ts has added line 5 only. */
const otherPatch = ["@@ -4,1 +4,2 @@", " const context4 = true;", "+const added5 = true;"].join(
  "\n",
);

/** The categories the run's agents own; anything else is dropped. */
const CATEGORIES = ["correctness", "security", "architecture"];

const changedFiles: ChangedFile[] = [
  {
    filename: "src/service.ts",
    status: "modified",
    additions: 3,
    deletions: 0,
    patch: servicePatch,
  },
  {
    filename: "src/other.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: otherPatch,
  },
  {
    filename: "assets/logo.png",
    status: "modified",
    additions: 0,
    deletions: 0,
  },
];

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: "src/service.ts",
    line: 10,
    category: "correctness",
    severity: "medium",
    title: "Off-by-one in pagination",
    explanation: "The page offset is computed from a 1-based index.",
    confidence: 0.9,
    ...overrides,
  };
}

describe("validateFindings", () => {
  it("returns an empty list for empty input", () => {
    expect(validateFindings([], changedFiles, CATEGORIES)).toEqual([]);
  });

  it("passes a fully valid set of findings through untouched", () => {
    const findings = [
      finding({ severity: "high", confidence: 0.95 }),
      finding({
        line: 11,
        category: "security",
        severity: "medium",
        title: "Unvalidated redirect target",
        confidence: 0.9,
      }),
      finding({
        file: "src/other.ts",
        line: 5,
        category: "architecture",
        severity: "low",
        title: "HTTP client constructed in the domain layer",
        confidence: 0.8,
      }),
    ];

    expect(validateFindings(findings, changedFiles, CATEGORIES)).toEqual(findings);
  });

  it("accepts a category no build ships, when the run configures it", () => {
    // The agent set is configurable, so the schema cannot judge this.
    const custom = finding({ category: "performance" });

    expect(validateFindings([custom], changedFiles, ["performance"])).toEqual([
      custom,
    ]);
  });

  it("drops a category outside the run's agents", () => {
    // The synthesiser must not be able to invent a category.
    const invented = finding({ category: "performance" });
    const kept = finding({ line: 11, category: "security" });

    expect(
      validateFindings([invented, kept], changedFiles, [
        "correctness",
        "security",
      ]),
    ).toEqual([kept]);
  });

  it("drops candidates that fail schema validation", () => {
    const invalid = { ...finding(), confidence: 1.5 };
    const missingTitle: Record<string, unknown> = { ...finding() };
    delete missingTitle["title"];

    expect(
      validateFindings([invalid, missingTitle, "not-a-finding"], changedFiles, CATEGORIES),
    ).toEqual([]);
  });

  it("drops findings that reference files not changed in the PR", () => {
    const wrongFile = finding({ file: "src/not-in-this-pr.ts" });

    expect(validateFindings([wrongFile], changedFiles, CATEGORIES)).toEqual([]);
  });

  it("drops line-anchored findings whose line is not an added line in the file's diff", () => {
    const outsideDiff = finding({ line: 99 });
    const contextLine = finding({ line: 9 });
    const addedLineInOtherFile = finding({ line: 5 });

    expect(
      validateFindings(
        [outsideDiff, contextLine, addedLineInOtherFile],
        changedFiles,
        CATEGORIES,
      ),
    ).toEqual([]);
  });

  it("keeps line-less findings on files that are in the PR", () => {
    const fileLevel = finding({ line: undefined });
    const { line: _line, ...withoutLine } = fileLevel;

    expect(validateFindings([withoutLine], changedFiles, CATEGORIES)).toEqual([
      withoutLine,
    ]);
  });

  it("drops line-anchored findings on files without a patch but keeps line-less ones", () => {
    const lineOnBinary = finding({ file: "assets/logo.png", line: 1 });
    const { line: _line, ...fileLevelOnBinary } = finding({
      file: "assets/logo.png",
      title: "Binary asset committed to source",
    });

    expect(
      validateFindings([lineOnBinary, fileLevelOnBinary], changedFiles, CATEGORIES),
    ).toEqual([fileLevelOnBinary]);
  });

  it("enforces the confidence threshold as a >= 0.70 boundary", () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.7);
    const justBelow = finding({ confidence: 0.69 });
    const atThreshold = finding({ confidence: 0.7 });

    expect(validateFindings([justBelow], changedFiles, CATEGORIES)).toEqual([]);
    expect(validateFindings([atThreshold], changedFiles, CATEGORIES)).toEqual([
      atThreshold,
    ]);
  });

  it("truncates more than 10 surviving findings to the strongest 10", () => {
    expect(MAX_FINDINGS).toBe(10);
    // 11 distinct findings; the weakest is a low-severity one despite
    // having higher confidence than some high-severity findings.
    const weakest = finding({
      line: 12,
      category: "architecture",
      severity: "low",
      title: "Weakest finding",
      confidence: 0.99,
    });
    // Nine distinct (line, category) anchors on src/service.ts plus one
    // on src/other.ts, so nothing here trips the duplicate rule.
    const strong = Array.from({ length: 9 }, (_, i) =>
      finding({
        line: 10 + (i % 3),
        category: (["correctness", "security", "architecture"] as const)[
          Math.floor(i / 3)
        ],
        severity: i < 5 ? "high" : "medium",
        title: `Strong finding ${i}`,
        confidence: 0.98 - i * 0.01,
      }),
    );
    strong.push(
      finding({
        file: "src/other.ts",
        line: 5,
        category: "correctness",
        severity: "medium",
        title: "Strong finding 9",
        confidence: 0.89,
      }),
    );

    const survivors = validateFindings([weakest, ...strong], changedFiles, CATEGORIES);

    expect(survivors).toHaveLength(10);
    expect(survivors.map((f) => f.title)).not.toContain("Weakest finding");
  });

  it("orders survivors strongest first: severity rank, then confidence, then input order", () => {
    const lowHighConfidence = finding({
      severity: "low",
      title: "Low severity, very confident",
      confidence: 0.99,
    });
    const highLessConfident = finding({
      line: 11,
      severity: "high",
      title: "High severity, less confident",
      confidence: 0.75,
    });
    const highMoreConfident = finding({
      line: 12,
      severity: "high",
      category: "security",
      title: "High severity, more confident",
      confidence: 0.9,
    });

    const survivors = validateFindings(
      [lowHighConfidence, highLessConfident, highMoreConfident],
      changedFiles,
      CATEGORIES,
    );

    expect(survivors.map((f) => f.title)).toEqual([
      "High severity, more confident",
      "High severity, less confident",
      "Low severity, very confident",
    ]);
  });

  it("collapses duplicates that share file, line, and category, keeping the strongest", () => {
    const strong = finding({
      severity: "high",
      title: "Null dereference on empty result",
      confidence: 0.9,
    });
    const weakDuplicate = finding({
      severity: "low",
      title: "A completely different title, same anchor",
      confidence: 0.8,
    });

    expect(validateFindings([weakDuplicate, strong], changedFiles, CATEGORIES)).toEqual([
      strong,
    ]);
  });

  it("collapses duplicates with near-identical titles on the same file, keeping the strongest", () => {
    const strong = finding({
      category: "security",
      severity: "high",
      title: "Missing tenant validation!",
      confidence: 0.9,
    });
    const weakDuplicate = finding({
      line: 11,
      category: "correctness",
      severity: "medium",
      title: "  missing   TENANT validation ",
      confidence: 0.85,
    });

    expect(validateFindings([weakDuplicate, strong], changedFiles, CATEGORIES)).toEqual([
      strong,
    ]);
  });

  it("treats line-less findings on the same file and category as duplicates of each other", () => {
    const first = finding({ severity: "high" });
    const { line: _l1, ...fileLevelA } = finding({
      title: "First file-level architecture concern",
      category: "architecture",
      severity: "medium",
      confidence: 0.9,
    });
    const { line: _l2, ...fileLevelB } = finding({
      title: "Second file-level architecture concern",
      category: "architecture",
      severity: "low",
      confidence: 0.95,
    });

    const survivors = validateFindings(
      [first, fileLevelA, fileLevelB],
      changedFiles,
      CATEGORIES,
    );

    expect(survivors).toEqual([first, fileLevelA]);
  });

  it("keeps distinct findings that share a line but differ in category and title", () => {
    const correctness = finding({ severity: "high" });
    const security = finding({
      category: "security",
      severity: "medium",
      title: "Session id logged in plain text",
      confidence: 0.8,
    });

    expect(validateFindings([correctness, security], changedFiles, CATEGORIES)).toEqual([
      correctness,
      security,
    ]);
  });

  it("removes duplicates before capping, so the cap is not spent on them", () => {
    // 11 valid findings; the strongest two are duplicates of each other.
    // Dedupe first (11 -> 10), then cap (10 -> 10) — a full review.
    const duplicateA = finding({
      severity: "high",
      title: "Duplicate anchor",
      confidence: 0.99,
    });
    const duplicateB = finding({
      severity: "high",
      title: "Same anchor, different words entirely",
      confidence: 0.98,
    });
    const anchors: [string, number, ReviewFinding["category"]][] = [
      ["src/service.ts", 10, "security"],
      ["src/service.ts", 10, "architecture"],
      ["src/service.ts", 11, "correctness"],
      ["src/service.ts", 11, "security"],
      ["src/service.ts", 11, "architecture"],
      ["src/service.ts", 12, "correctness"],
      ["src/service.ts", 12, "security"],
      ["src/service.ts", 12, "architecture"],
      ["src/other.ts", 5, "correctness"],
    ];
    const rest = anchors.map(([file, line, category], i) =>
      finding({
        file,
        line,
        category,
        severity: "medium",
        title: `Distinct finding ${i}`,
        confidence: 0.97 - i * 0.01,
      }),
    );

    const survivors = validateFindings(
      [duplicateA, duplicateB, ...rest],
      changedFiles,
      CATEGORIES,
    );

    expect(survivors).toHaveLength(MAX_FINDINGS);
    expect(survivors[0]).toEqual(duplicateA);
    expect(survivors.map((f) => f.title)).not.toContain(
      "Same anchor, different words entirely",
    );
    // The slot the duplicate used to waste now carries a real finding.
    expect(survivors.map((f) => f.title)).toContain("Distinct finding 8");
  });
});
