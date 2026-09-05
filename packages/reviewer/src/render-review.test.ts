import type { ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import {
  feedbackMarker,
  findingMarker,
  parseFeedbackMarker,
  postedFindingKeys,
  renderReview,
} from "./render-review.js";

const traceId = "0af7651916cd43dd8448eb211c80319c";

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

  it("posts nothing when only an agent failed, leaving the check run to say so", () => {
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

  it("carries the severity and agent into the comment heading", () => {
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

  it("skips a finding already posted on an earlier commit", () => {
    const posted = postedFindingKeys([
      { body: `anything\n\n${findingMarker(finding())}` },
    ]);

    expect(renderReview([finding()], [], posted)).toBeUndefined();
  });

  it("keys a finding on file and title, so a moved line is not reposted", () => {
    const posted = postedFindingKeys([
      { body: findingMarker(finding({ line: 12 })) },
    ]);

    expect(renderReview([finding({ line: 400 })], [], posted)).toBeUndefined();
  });

  it("posts only the findings that are new, and says how many it held back", () => {
    const posted = postedFindingKeys([{ body: findingMarker(finding()) }]);
    const rendered = renderReview(
      [finding(), finding({ title: "Brand new", line: 20 })],
      [],
      posted,
    );

    expect(rendered?.comments).toHaveLength(1);
    expect(rendered?.comments[0]?.body).toContain("Brand new");
    expect(rendered?.body).toContain("1 further finding");
  });

  it("ignores a comment carrying no marker", () => {
    expect(postedFindingKeys([{ body: "a human wrote this" }]).size).toBe(0);
  });

  it("stamps every comment with its category and the run's trace id", () => {
    const rendered = renderReview(
      [finding(), finding({ category: "security", title: "Open redirect", line: 13 })],
      [],
      new Set(),
      { traceId },
    );

    const metas = rendered?.comments.map((comment) => parseFeedbackMarker(comment.body));
    expect(metas).toEqual([
      { category: "correctness", traceId },
      { category: "security", traceId },
    ]);
    // The trace marker must not disturb the finding key the next push reads.
    expect(
      postedFindingKeys(rendered?.comments ?? []).has(
        `${finding().file}|assignment instead of comparison in admin check`,
      ),
    ).toBe(true);
  });

  it("still names the category when the run was not traced", () => {
    const rendered = renderReview([finding()]);

    expect(parseFeedbackMarker(rendered?.comments[0]?.body ?? "")).toEqual({
      category: "correctness",
    });
  });

  it("notes an agent that did not complete", () => {
    const rendered = renderReview(
      [finding()],
      [{ agent: "architecture", error: "timed out" }],
    );

    expect(rendered?.body).toContain("The Architecture review did not complete");
  });
});

describe("parseFeedbackMarker", () => {
  it("round-trips the marker", () => {
    expect(parseFeedbackMarker(feedbackMarker({ category: "security", traceId }))).toEqual({
      category: "security",
      traceId,
    });
  });

  it("returns undefined for a comment without a marker", () => {
    expect(parseFeedbackMarker("looks good to me")).toBeUndefined();
  });

  it("drops a trace id that is not 32 hex characters", () => {
    expect(
      parseFeedbackMarker("<!-- pr-review-meta: category=security trace=not-a-trace -->"),
    ).toEqual({ category: "security" });
  });

  it("needs a category", () => {
    expect(
      parseFeedbackMarker(`<!-- pr-review-meta: trace=${traceId} -->`),
    ).toBeUndefined();
  });

});
