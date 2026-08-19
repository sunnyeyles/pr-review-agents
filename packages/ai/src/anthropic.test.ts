/**
 * The Anthropic client factory. Construction only — no request is ever
 * made, which the fetch stub below proves rather than assumes.
 */
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAnthropicClient } from "./anthropic.js";

const AMBIENT_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

describe("createAnthropicClient", () => {
  const saved = new Map<string, string | undefined>();
  let fetchSpy: ReturnType<typeof vi.fn>;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const key of AMBIENT_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    // Any network attempt during construction becomes a loud failure.
    realFetch = globalThis.fetch;
    fetchSpy = vi.fn(() => {
      throw new Error("no network in tests");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
  });

  it("returns a client satisfying the AnthropicLike seam", () => {
    const client = createAnthropicClient({ apiKey: "sk-test-key" });
    expect(typeof client.messages.create).toBe("function");
  });

  it("builds a real Anthropic SDK client", () => {
    expect(createAnthropicClient({ apiKey: "sk-test-key" })).toBeInstanceOf(
      Anthropic,
    );
  });

  it("uses the injected key rather than the ambient environment", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ambient-key";
    const client = createAnthropicClient({ apiKey: "sk-injected-key" });
    expect((client as unknown as Anthropic).apiKey).toBe("sk-injected-key");
  });

  it("makes no request while constructing the client", () => {
    createAnthropicClient({ apiKey: "sk-test-key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns an independent client per call", () => {
    const first = createAnthropicClient({ apiKey: "sk-one" });
    const second = createAnthropicClient({ apiKey: "sk-two" });
    expect(first).not.toBe(second);
    expect((first as unknown as Anthropic).apiKey).toBe("sk-one");
    expect((second as unknown as Anthropic).apiKey).toBe("sk-two");
  });
});
