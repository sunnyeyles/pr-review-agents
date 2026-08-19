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
): Anthropic.Messages.Usage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
  } as Anthropic.Messages.Usage;
}

describe("emptyTokenUsage", () => {
  it("starts both counters at zero", () => {
    expect(emptyTokenUsage()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("returns a fresh object each call, so totals never alias", () => {
    const first = emptyTokenUsage();
    const second = emptyTokenUsage();
    expect(first).not.toBe(second);
  });
});

describe("addTokenUsage", () => {
  it("adds one response's usage to a running total", () => {
    expect(addTokenUsage(emptyTokenUsage(), usage(120, 45))).toEqual({
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it("accumulates across the turns of one agent run", () => {
    const total = [usage(100, 10), usage(250, 30), usage(5, 1)].reduce(
      addTokenUsage,
      emptyTokenUsage(),
    );
    expect(total).toEqual({ inputTokens: 355, outputTokens: 41 });
  });

  it("leaves the total unchanged for a zero usage block", () => {
    const total = { inputTokens: 7, outputTokens: 3 };
    expect(addTokenUsage(total, usage(0, 0))).toEqual(total);
  });

  it("does not mutate the running total it was given", () => {
    const total = emptyTokenUsage();
    const next = addTokenUsage(total, usage(9, 4));
    expect(total).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(next).not.toBe(total);
  });

  it("counts only the two token fields, ignoring the cache fields", () => {
    const withCache = {
      ...usage(10, 2),
      cache_creation_input_tokens: 999,
      cache_read_input_tokens: 888,
    } as Anthropic.Messages.Usage;
    expect(addTokenUsage(emptyTokenUsage(), withCache)).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it("keeps the accumulated shape to exactly the two counters", () => {
    expect(Object.keys(addTokenUsage(emptyTokenUsage(), usage(1, 1))).sort()).toEqual(
      ["inputTokens", "outputTokens"],
    );
  });
});
