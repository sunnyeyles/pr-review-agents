import type { ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import {
  MAX_ANNOTATIONS_PER_REQUEST,
  renderCheckRun,
  renderNoAgentMatched,
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

describe("renderCheckRun with agent failures", () => {
  const failure = {
    agent: "security",
    error: "model unavailable at https://internal-host.example",
  };

  it("notes the failed agent in the summary alongside the surviving findings", () => {
    const rendered = renderCheckRun([finding()], [failure]);

    expect(rendered.conclusion).toBe("neutral");
    expect(rendered.output.title).toBe("1 finding");
    expect(rendered.output.summary).toContain(
      "API failures are being returned as empty results.",
    );
    expect(rendered.output.summary).toMatch(
      /security review.*(did not complete|failed)/is,
    );
  });

  it("notes the failed agent even when no finding survived, without claiming success", () => {
    const rendered = renderCheckRun([], [failure]);

    // A review missing a whole agent must not publish a clean bill of
    // health: the conclusion drops from "success" to "neutral".
    expect(rendered.conclusion).toBe("neutral");
    expect(rendered.output.title).toMatch(/no issues found/i);
    expect(rendered.output.summary).toMatch(
      /security review.*(did not complete|failed)/is,
    );
  });

  it("lists every failed agent", () => {
    const rendered = renderCheckRun(
      [],
      [failure, { agent: "architecture", error: "turn cap exceeded" }],
    );

    expect(rendered.output.summary).toMatch(/security/i);
    expect(rendered.output.summary).toMatch(/architecture/i);
  });

  it("never leaks the failure error detail into the check run", () => {
    const rendered = renderCheckRun([finding()], [failure]);

    expect(rendered.output.summary).not.toContain("internal-host.example");
    expect(rendered.output.summary).not.toContain("model unavailable");
  });

  it("changes nothing when there are no failures", () => {
    expect(renderCheckRun([finding()], [])).toEqual(renderCheckRun([finding()]));
    expect(renderCheckRun([], [])).toEqual(renderCheckRun([]));
  });
});

describe("renderCheckRun with skipped agents", () => {
  const skipped = [
    { agent: "security", paths: ["packages/github/**", "**/auth/**"] },
  ];

  it("names the skipped agent and the paths it waited for", () => {
    const rendered = renderCheckRun([finding()], [], { skippedAgents: skipped });

    expect(rendered.output.summary).toMatch(/security review did not run/i);
    expect(rendered.output.summary).toContain("`packages/github/**`");
    expect(rendered.output.summary).toContain("`**/auth/**`");
  });

  it("still reports success when the agents that did run found nothing", () => {
    // A skip is configured, unlike a failure: the review the repository
    // asked for ran in full, so the check is not degraded.
    const rendered = renderCheckRun([], [], { skippedAgents: skipped });

    expect(rendered.conclusion).toBe("success");
    expect(rendered.output.title).toMatch(/no issues found/i);
    expect(rendered.output.summary).toMatch(/security review did not run/i);
  });

  it("changes nothing when no agent was skipped", () => {
    expect(renderCheckRun([finding()], [], { skippedAgents: [] })).toEqual(
      renderCheckRun([finding()]),
    );
    expect(renderCheckRun([], [], { skippedAgents: [] })).toEqual(
      renderCheckRun([]),
    );
  });
});

describe("renderNoAgentMatched", () => {
  const skipped = [
    { agent: "security", paths: ["packages/github/**"] },
    { agent: "docs-drift", paths: ["docs/**"] },
  ];

  it("is neutral, never a green check on an unreviewed pull request", () => {
    const rendered = renderNoAgentMatched(skipped, ["README.md"]);

    expect(rendered.conclusion).toBe("neutral");
    expect(rendered.output.title).toBe("No agent reviewed this pull request");
    expect(rendered.output.summary).toContain("was not reviewed");
  });

  it("names every agent with the paths it waited for", () => {
    const summary = renderNoAgentMatched(skipped, ["README.md"]).output.summary;

    expect(summary).toContain("Security — waiting on `packages/github/**`");
    expect(summary).toContain("Docs drift — waiting on `docs/**`");
    expect(summary).toContain("None of the 2 configured agents");
  });

  it("lists the changed files so the decision can be checked at a glance", () => {
    const summary = renderNoAgentMatched(skipped, [
      "README.md",
      "docs/index.html",
    ]).output.summary;

    expect(summary).toContain("the 2 changed files");
    expect(summary).toContain("Changed: `README.md`, `docs/index.html`.");
  });

  it("caps the file list so a large pull request cannot bury the reason", () => {
    const files = Array.from({ length: 14 }, (_, index) => `src/file${index}.ts`);

    const summary = renderNoAgentMatched(skipped, files).output.summary;

    expect(summary).toContain("`src/file9.ts`, and 4 more.");
    expect(summary).not.toContain("src/file10.ts");
  });

  it("omits the file list when a pull request changed nothing", () => {
    const summary = renderNoAgentMatched(skipped, []).output.summary;

    expect(summary).not.toContain("Changed:");
    expect(summary).toContain("the 0 changed files");
  });
});
