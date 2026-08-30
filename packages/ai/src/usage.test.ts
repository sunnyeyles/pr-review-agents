/**
 * The token-usage accumulator. Pure arithmetic over the `usage` block
 * of an Anthropic response — no client, no network.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { addTokenUsage, emptyTokenUsage } from "./usage.js";

/** A usage block in the shape the SDK returns, cache fields included. */
function usage(
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens: number | null = null,
  cacheReadInputTokens: number | null = null,
): Anthropic.Messages.Usage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
  } as Anthropic.Messages.Usage;
}

/** The four counters, spelled out where a test asserts a whole total. */
function total(
  inputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
  outputTokens: number,
) {
  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
  };
}

describe("emptyTokenUsage", () => {
  it("starts every counter at zero", () => {
    expect(emptyTokenUsage()).toEqual(total(0, 0, 0, 0));
  });

  it("returns a fresh object each call, so totals never alias", () => {
    const first = emptyTokenUsage();
    const second = emptyTokenUsage();
    expect(first).not.toBe(second);
  });
});

describe("addTokenUsage", () => {
  it("adds one response's usage to a running total", () => {
    expect(addTokenUsage(emptyTokenUsage(), usage(120, 45))).toEqual(
      total(120, 0, 0, 45),
    );
  });

  it("accumulates across the turns of one agent run", () => {
    const accumulated = [usage(100, 10), usage(250, 30), usage(5, 1)].reduce(
      addTokenUsage,
      emptyTokenUsage(),
    );
    expect(accumulated).toEqual(total(355, 0, 0, 41));
  });

  it("leaves the total unchanged for a zero usage block", () => {
    const running = total(7, 2, 5, 3);
    expect(addTokenUsage(running, usage(0, 0))).toEqual(running);
  });

  it("does not mutate the running total it was given", () => {
    const running = emptyTokenUsage();
    const next = addTokenUsage(running, usage(9, 4));
    expect(running).toEqual(total(0, 0, 0, 0));
    expect(next).not.toBe(running);
  });

  it("counts cache writes and reads as their own counters", () => {
    expect(
      addTokenUsage(emptyTokenUsage(), usage(10, 2, 999, 888)),
    ).toEqual(total(10, 999, 888, 2));
  });

  it("accumulates the cache counters across the turns of one run", () => {
    // Turn one writes the prefix; later turns read it back.
    const accumulated = [
      usage(20, 10, 4_000, 0),
      usage(5, 8, 300, 4_000),
      usage(5, 6, 200, 4_300),
    ].reduce(addTokenUsage, emptyTokenUsage());
    expect(accumulated).toEqual(total(30, 4_500, 8_300, 24));
  });

  it("treats an absent cache counter as zero, not NaN", () => {
    // A response from a request with no caching reports null here.
    expect(addTokenUsage(emptyTokenUsage(), usage(10, 2, null, null))).toEqual(
      total(10, 0, 0, 2),
    );
  });

  it("keeps the accumulated shape to exactly the four counters", () => {
    expect(Object.keys(addTokenUsage(emptyTokenUsage(), usage(1, 1))).sort()).toEqual(
      [
        "cacheCreationInputTokens",
        "cacheReadInputTokens",
        "inputTokens",
        "outputTokens",
      ],
    );
  });
});
