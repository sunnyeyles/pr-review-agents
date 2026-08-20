import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCapturingLogger,
  createConsoleLogger,
  errorMessage,
  errorName,
} from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createConsoleLogger", () => {
  it("emits info events as one single-line JSON object on stdout", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createConsoleLogger();

    logger.info("review.started", {
      repository: "octo-org/example-service",
      pullRequestNumber: 42,
    });

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]?.[0] as string;
    expect(typeof line).toBe("string");
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      level: "info",
      event: "review.started",
      repository: "octo-org/example-service",
      pullRequestNumber: 42,
    });
  });

  it("emits error events as one single-line JSON object on stderr", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createConsoleLogger();

    logger.error("review.failed", { error: "boom", errorName: "Error" });

    expect(error).toHaveBeenCalledTimes(1);
    const line = error.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line)).toEqual({
      level: "error",
      event: "review.failed",
      error: "boom",
      errorName: "Error",
    });
  });

  it("emits the event with no extra fields when none are given", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createConsoleLogger();

    logger.info("synthesis.started");

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
      level: "info",
      event: "synthesis.started",
    });
  });

  it("drops undefined-valued fields from the JSON line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createConsoleLogger();

    logger.info("synthesis.completed", {
      refinedCount: 2,
      inputTokens: undefined,
    });

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
      level: "info",
      event: "synthesis.completed",
      refinedCount: 2,
    });
  });

  it("keeps nested fields on a single line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createConsoleLogger();

    logger.info("agent.completed", { usage: { inputTokens: 10, outputTokens: 2 } });

    expect(log.mock.calls[0]?.[0]).not.toContain("\n");
  });
});

describe("createCapturingLogger", () => {
  it("records events in order with level, event, and flattened fields", () => {
    const { logger, entries } = createCapturingLogger();

    logger.info("agent.started", { agent: "correctness" });
    logger.error("agent.failed", { agent: "security", error: "boom" });

    expect(entries).toEqual([
      { level: "info", event: "agent.started", agent: "correctness" },
      { level: "error", event: "agent.failed", agent: "security", error: "boom" },
    ]);
  });

  it("writes nothing to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logger } = createCapturingLogger();

    logger.info("review.started", {});
    logger.error("review.failed", {});

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("errorMessage", () => {
  it("takes the message from an Error", () => {
    expect(errorMessage(new Error("langfuse unavailable"))).toBe(
      "langfuse unavailable",
    );
  });

  it("keeps a subclass's message", () => {
    class SynthesisError extends Error {}
    expect(errorMessage(new SynthesisError("invalid output"))).toBe(
      "invalid output",
    );
  });

  it.each([
    ["a thrown string", "boom", "boom"],
    ["a thrown number", 42, "42"],
    ["a thrown null", null, "null"],
    ["a thrown undefined", undefined, "undefined"],
  ])("stringifies %s", (_label, thrown, expected) => {
    // A catch binding is `unknown`: anything can be thrown, and a
    // failure path must still produce a loggable line.
    expect(errorMessage(thrown)).toBe(expected);
  });
});

describe("errorName", () => {
  it("takes the name from an Error", () => {
    expect(errorName(new TypeError("bad"))).toBe("TypeError");
  });

  it("names a subclass", () => {
    class AgentRunError extends Error {
      override name = "AgentRunError";
    }
    expect(errorName(new AgentRunError("stopped"))).toBe("AgentRunError");
  });

  it("falls back to Error for a non-Error throw", () => {
    expect(errorName("boom")).toBe("Error");
  });
});
