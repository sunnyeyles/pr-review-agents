import { describe, expect, it } from "vitest";

import { buildReviewSystemPrompt } from "../definition.js";
import { CORRECTNESS_AGENT } from "./correctness-agent.js";

const guidance = CORRECTNESS_AGENT.contextGuidance ?? "";

describe("the correctness agent", () => {
  it("owns exactly the correctness category", () => {
    // The synthesiser discards findings in any other category.
    expect(CORRECTNESS_AGENT.category).toBe("correctness");
  });

  it("carries its category, focus, and context guidance into its prompt", () => {
    const prompt = buildReviewSystemPrompt(CORRECTNESS_AGENT);

    expect(prompt).toContain(CORRECTNESS_AGENT.category);
    expect(prompt).toContain(CORRECTNESS_AGENT.focus);
    expect(guidance).not.toBe("");
    expect(prompt).toContain(guidance);
  });

  it("tells the agent which areas belong to the other specialists", () => {
    const prompt = buildReviewSystemPrompt(CORRECTNESS_AGENT);

    for (const other of ["security", "performance", "test-coverage", "docs-drift"]) {
      expect(prompt).toContain(other);
    }
  });

  it("names the tools it must read the code with", () => {
    for (const tool of ["get_file", "get_base_file", "search_repository", "find_importers"]) {
      expect(guidance).toContain(tool);
    }
  });
});
