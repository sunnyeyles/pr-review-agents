import { describe, expect, it } from "vitest";

import { buildReviewSystemPrompt } from "../definition.js";
import { TEST_COVERAGE_AGENT } from "./test-coverage-agent.js";

describe("TEST_COVERAGE_AGENT", () => {
  it("owns the test-coverage category and nothing else", () => {
    expect(TEST_COVERAGE_AGENT.category).toBe("test-coverage");
  });

  it("names its category, focus, and guidance in the system prompt", () => {
    const prompt = buildReviewSystemPrompt(TEST_COVERAGE_AGENT);
    const guidance = TEST_COVERAGE_AGENT.contextGuidance ?? "";

    expect(guidance).not.toBe("");
    expect(prompt).toContain(TEST_COVERAGE_AGENT.category);
    expect(prompt).toContain(TEST_COVERAGE_AGENT.focus);
    expect(prompt).toContain(guidance);
  });

  it("sends the agent looking for the existing test file first", () => {
    const guidance = TEST_COVERAGE_AGENT.contextGuidance ?? "";

    expect(guidance).toContain("search_repository");
    expect(guidance).toContain("list_changed_files");
    expect(guidance).toContain("get_file");
  });
});
