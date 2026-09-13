import { describe, expect, it } from "vitest";

import { buildReviewSystemPrompt } from "../definition.js";
import { PERFORMANCE_AGENT } from "./performance-agent.js";

describe("PERFORMANCE_AGENT", () => {
  it("owns exactly the performance category", () => {
    expect(PERFORMANCE_AGENT.category).toBe("performance");
  });

  it("carries its focus, category, and context guidance into the prompt", () => {
    const prompt = buildReviewSystemPrompt(PERFORMANCE_AGENT);

    expect(prompt).toContain(PERFORMANCE_AGENT.category);
    expect(prompt).toContain(PERFORMANCE_AGENT.focus);
    expect(prompt).toContain(PERFORMANCE_AGENT.contextGuidance);
  });

  it("tells the agent to read callers before reporting", () => {
    expect(PERFORMANCE_AGENT.contextGuidance).toContain("find_importers");
    expect(PERFORMANCE_AGENT.contextGuidance).toContain("get_file");
    expect(PERFORMANCE_AGENT.contextGuidance).toContain("search_repository");
  });

  it("hands the other categories away", () => {
    for (const category of ["correctness", "security", "test-coverage", "docs-drift"]) {
      expect(PERFORMANCE_AGENT.focus).toContain(category);
    }
  });
});
