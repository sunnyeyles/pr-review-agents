import type { ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import { renderReview } from "./render-review.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: "src/sessions.ts",
    line: 12,
    category: "correctness",
    severity: "high",
    title: "Assignment instead of comparison in admin check",
    explanation: "The condition assigns instead of comparing.",
    confidence: 0.9,
    ...overrides,
  };
}

describe("renderReview", () => {
  it("posts nothing when there are no findings", () => {
    expect(renderReview([])).toBeUndefined();
  });

  it("posts nothing when only a lens failed, leaving the check run to say so", () => {
    expect(renderReview([], [{ agent: "security", error: "timed out" }])).toBeUndefined();
  });

  it("turns a line-anchored finding into an inline comment", () => {
    const rendered = renderReview([finding()]);

    expect(rendered?.comments).toEqual([
      {
        path: "src/sessions.ts",
        line: 12,
        body: expect.stringContaining("Assignment instead of comparison"),
      },
    ]);
  });

  it("carries the severity and lens into the comment heading", () => {
    const rendered = renderReview([finding({ severity: "medium", category: "security" })]);

    expect(rendered?.comments[0]?.body).toContain("**MEDIUM — Security:");
  });

  it("includes a suggested fix in the comment when the finding has one", () => {
    const rendered = renderReview([finding({ suggestedFix: "Use === instead." })]);

    expect(rendered?.comments[0]?.body).toContain("**Suggested fix:** Use === instead.");
  });

  it("carries a file-level finding in the body rather than dropping it", () => {
    const rendered = renderReview([finding({ line: undefined })]);

    expect(rendered?.comments).toEqual([]);
    expect(rendered?.body).toContain("apply to a file rather than a line");
    expect(rendered?.body).toContain("Assignment instead of comparison");
  });

  it("counts every finding in the body header", () => {
    const rendered = renderReview([
      finding({ line: 12 }),
      finding({ line: 13, title: "Second" }),
    ]);

    expect(rendered?.body).toContain("AI PR Review — 2 findings");
    expect(rendered?.comments).toHaveLength(2);
  });

  it("orders comments strongest first", () => {
    const rendered = renderReview([
      finding({ line: 12, severity: "low", title: "Weak" }),
      finding({ line: 13, severity: "high", title: "Strong" }),
    ]);

    expect(rendered?.comments[0]?.body).toContain("Strong");
    expect(rendered?.comments[1]?.body).toContain("Weak");
  });

  it("notes a lens that did not complete", () => {
    const rendered = renderReview(
      [finding()],
      [{ agent: "architecture", error: "timed out" }],
    );

    expect(rendered?.body).toContain("The Architecture review did not complete");
  });
});
