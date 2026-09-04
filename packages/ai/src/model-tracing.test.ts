/** The shape of the generation observation both packages share. */
import { describe, expect, it, vi } from "vitest";

import { traceModelCall, type GenerationParent } from "./model-tracing.js";
import { message, textBlock } from "./agent-test-support.js";

/** Records what a generation observation was told, without Langfuse. */
function fakeParent() {
  const updates: Record<string, unknown>[] = [];
  const starts: { name: string; attributes: Record<string, unknown> }[] = [];
  let ended = 0;
  const generation = {
    update(attributes: Record<string, unknown>) {
      updates.push(attributes);
      return generation;
    },
    end() {
      ended += 1;
      return generation;
    },
  };
  const parent = {
    startObservation(name: string, attributes: Record<string, unknown>) {
      starts.push({ name, attributes });
      return generation;
    },
  } as unknown as GenerationParent;
  return { parent, starts, updates, endCount: () => ended };
}

const response = message([textBlock("done")], "end_turn", {
  inputTokens: 11,
  outputTokens: 7,
  cacheCreationInputTokens: 500,
  cacheReadInputTokens: 9000,
});

describe("traceModelCall", () => {
  it("opens one call-model generation with the call's shape", async () => {
    const { parent, starts } = fakeParent();

    await traceModelCall(
      parent,
      {
        provider: "test-provider",
        model: "test-model",
        input: { messageCount: 3 },
        maxTokens: 8_000,
      },
      () => Promise.resolve(response),
    );

    expect(starts).toEqual([
      {
        name: "call-model",
        attributes: {
          model: "test-model",
          input: { messageCount: 3 },
          modelParameters: { maxTokens: 8_000 },
          metadata: { provider: "test-provider" },
        },
      },
    ]);
  });

  it("records the stop reason, block count, and all four token counters", async () => {
    const { parent, updates, endCount } = fakeParent();

    const result = await traceModelCall(
      parent,
      { provider: "p", model: "m", input: {}, maxTokens: 1 },
      () => Promise.resolve(response),
    );

    expect(result).toBe(response);
    expect(updates).toEqual([
      {
        output: { stopReason: "end_turn", contentBlockCount: 1 },
        usageDetails: {
          input: 11,
          output: 7,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 500,
        },
      },
    ]);
    expect(endCount()).toBe(1);
  });

  it("spells the cache counters the way Langfuse prices OpenAI models", async () => {
    const { parent, updates } = fakeParent();

    await traceModelCall(
      parent,
      { provider: "openai", model: "m", input: {}, maxTokens: 1 },
      () => Promise.resolve(response),
    );

    expect(updates[0]?.["usageDetails"]).toEqual({
      input: 11,
      output: 7,
      input_cached_tokens: 9000,
    });
  });

  it("reports zero rather than null when a call touched no cache", async () => {
    const { parent, updates } = fakeParent();
    const uncached = message([textBlock("done")], "end_turn", {
      inputTokens: 11,
      outputTokens: 7,
    });

    await traceModelCall(
      parent,
      { provider: "p", model: "m", input: {}, maxTokens: 1 },
      () => Promise.resolve(uncached),
    );

    expect(updates[0]?.["usageDetails"]).toEqual({
      input: 11,
      output: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("records a failure at ERROR and still ends the observation", async () => {
    const { parent, updates, endCount } = fakeParent();

    await expect(
      traceModelCall(parent, { provider: "p", model: "m", input: {}, maxTokens: 1 }, () =>
        Promise.reject(new Error("overloaded")),
      ),
    ).rejects.toThrow("overloaded");

    expect(updates).toEqual([{ level: "ERROR", statusMessage: "overloaded" }]);
    // An unended observation is never exported.
    expect(endCount()).toBe(1);
  });

  it("never swallows the caller's error", async () => {
    const { parent } = fakeParent();
    const thrown = new Error("rate limited");

    const call = vi.fn(() => Promise.reject(thrown));
    await expect(
      traceModelCall(parent, { provider: "p", model: "m", input: {}, maxTokens: 1 }, call),
    ).rejects.toBe(thrown);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
