import { describe, expect, it } from "vitest";

import { agentOutputSchema, extractAgentOutput } from "./output.js";

const validFinding = {
  file: "src/sessions.ts",
  line: 42,
  category: "correctness",
  severity: "high",
  title: "Assignment instead of comparison in auth check",
  explanation: "The condition assigns true to user.isAdmin instead of comparing.",
  suggestedFix: "Use === instead of =.",
  confidence: 0.95,
};

describe("agentOutputSchema", () => {
  it("accepts a findings array of the shared finding shape", () => {
    const parsed = agentOutputSchema.safeParse({ findings: [validFinding] });

    expect(parsed.success).toBe(true);
  });

  it("accepts an empty findings array (clean review)", () => {
    expect(agentOutputSchema.safeParse({ findings: [] }).success).toBe(true);
  });

  it("rejects output without a findings array", () => {
    expect(agentOutputSchema.safeParse({ issues: [validFinding] }).success).toBe(false);
  });

  it("rejects findings that violate the shared schema", () => {
    const outOfRange = { ...validFinding, confidence: 1.5 };

    expect(
      agentOutputSchema.safeParse({ findings: [outOfRange] }).success,
    ).toBe(false);
  });
});

describe("extractAgentOutput", () => {
  it("parses a bare JSON object", () => {
    const result = extractAgentOutput(JSON.stringify({ findings: [validFinding] }));

    expect(result).toEqual({ ok: true, findings: [validFinding] });
  });

  it("parses JSON wrapped in a markdown code fence with surrounding prose", () => {
    const text = [
      "Here are my findings:",
      "```json",
      JSON.stringify({ findings: [validFinding] }),
      "```",
    ].join("\n");

    const result = extractAgentOutput(text);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toEqual([validFinding]);
    }
  });

  it("fails on text without any JSON object", () => {
    const result = extractAgentOutput("I could not find any issues worth reporting.");

    expect(result.ok).toBe(false);
  });

  it("fails on JSON that is not the agent-output shape", () => {
    const result = extractAgentOutput(JSON.stringify({ verdict: "approve" }));

    expect(result.ok).toBe(false);
  });

  it("fails on truncated JSON", () => {
    const text = JSON.stringify({ findings: [validFinding] }).slice(0, 40);

    expect(extractAgentOutput(text).ok).toBe(false);
  });
});
