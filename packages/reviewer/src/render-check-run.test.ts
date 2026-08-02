import type { ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import {
  MAX_ANNOTATIONS_PER_REQUEST,
  renderCheckRun,
} from "./render-check-run.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: "src/orders/service.ts",
    line: 42,
    category: "correctness",
    severity: "medium",
    title: "API failures returned as empty results",
    explanation: "API failures are being returned as empty results.",
    confidence: 0.85,
    ...overrides,
  };
}

describe("renderCheckRun with no findings", () => {
  it("renders a clean success check run", () => {
    const rendered = renderCheckRun([]);

    expect(rendered.conclusion).toBe("success");
    expect(rendered.output.title).toMatch(/no issues found/i);
    expect(rendered.output.summary).toMatch(/no issues/i);
  });

  it("carries no annotations", () => {
    const rendered = renderCheckRun([]);

    expect(rendered.output.annotations).toBeUndefined();
  });
});

describe("renderCheckRun with findings", () => {
  const security = finding({
    file: "src/auth/session.ts",
    line: 84,
    category: "security",
    severity: "high",
    title: "Missing tenant validation",
    explanation:
      "Missing tenant validation could allow access to another tenant's session.",
    suggestedFix: "Filter the session query by the authenticated tenant id.",
    confidence: 0.9,
  });
  const correctness = finding();

  it("publishes a neutral conclusion so advisory findings do not block merges", () => {
    expect(renderCheckRun([security, correctness]).conclusion).toBe("neutral");
  });

  it("counts the findings in the title, with singular and plural forms", () => {
    expect(renderCheckRun([security]).output.title).toBe("1 finding");
    expect(renderCheckRun([security, correctness]).output.title).toBe(
      "2 findings",
    );
  });

  it("lists every finding in the summary with severity, category, location, and explanation", () => {
    const { output } = renderCheckRun([security, correctness]);

    expect(output.summary).toContain("HIGH — Security");
    expect(output.summary).toContain("src/auth/session.ts:84");
    expect(output.summary).toContain("Missing tenant validation");
    expect(output.summary).toContain(
      "Missing tenant validation could allow access to another tenant's session.",
    );
    expect(output.summary).toContain("MEDIUM — Correctness");
    expect(output.summary).toContain("src/orders/service.ts:42");
    expect(output.summary).toContain(
      "API failures are being returned as empty results.",
    );
  });

  it("orders the summary by severity, then confidence", () => {
    const low = finding({
      severity: "low",
      title: "Low severity note",
      confidence: 0.99,
    });
    const { output } = renderCheckRun([low, correctness, security]);

    const highIndex = output.summary.indexOf("HIGH — Security");
    const mediumIndex = output.summary.indexOf("MEDIUM — Correctness");
    const lowIndex = output.summary.indexOf("LOW — Correctness");
    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(mediumIndex).toBeGreaterThan(highIndex);
    expect(lowIndex).toBeGreaterThan(mediumIndex);
  });

  it("includes the suggested fix in the summary when present", () => {
    const { output } = renderCheckRun([security]);

    expect(output.summary).toContain(
      "Filter the session query by the authenticated tenant id.",
    );
  });

  it("renders a file-level finding without a line suffix", () => {
    const { line: _line, ...fileLevel } = finding({
      title: "File-level architecture concern",
      category: "architecture",
    });
    const { output } = renderCheckRun([fileLevel]);

    expect(output.summary).toContain("src/orders/service.ts");
    expect(output.summary).not.toContain("src/orders/service.ts:");
  });

  it("annotates line-anchored findings and skips file-level ones", () => {
    const { line: _line, ...fileLevel } = finding({
      title: "File-level architecture concern",
      category: "architecture",
    });
    const { output } = renderCheckRun([security, fileLevel]);

    expect(output.annotations).toEqual([
      {
        path: "src/auth/session.ts",
        start_line: 84,
        end_line: 84,
        annotation_level: "failure",
        title: "Missing tenant validation",
        message:
          "Missing tenant validation could allow access to another tenant's session." +
          "\n\nSuggested fix: Filter the session query by the authenticated tenant id.",
      },
    ]);
  });

  it("omits the annotations field when no finding is line-anchored", () => {
    const { line: _line, ...fileLevel } = finding();
    const { output } = renderCheckRun([fileLevel]);

    expect(output.annotations).toBeUndefined();
  });

  it("maps severity to the annotation level", () => {
    const { output } = renderCheckRun([
      finding({ severity: "high", title: "High" }),
      finding({ severity: "medium", title: "Medium" }),
      finding({ severity: "low", title: "Low" }),
    ]);

    expect(output.annotations?.map((a) => a.annotation_level)).toEqual([
      "failure",
      "warning",
      "notice",
    ]);
  });

  it("annotates the explanation without a fix suffix when no fix is suggested", () => {
    const { output } = renderCheckRun([correctness]);

    expect(output.annotations?.[0]?.message).toBe(
      "API failures are being returned as empty results.",
    );
  });

  it("caps annotations at 50 per request, keeping the strongest findings", () => {
    expect(MAX_ANNOTATIONS_PER_REQUEST).toBe(50);
    const many = Array.from({ length: 55 }, (_, i) =>
      finding({
        line: i + 1,
        severity: i === 54 ? "high" : "low",
        title: `Finding ${i}`,
        confidence: 0.7 + i * 0.005,
      }),
    );

    const { output } = renderCheckRun(many);

    expect(output.annotations).toHaveLength(50);
    // The single high-severity finding sorts first despite being last in.
    expect(output.annotations?.[0]?.title).toBe("Finding 54");
    expect(output.annotations?.[0]?.start_line).toBe(55);
  });
});
