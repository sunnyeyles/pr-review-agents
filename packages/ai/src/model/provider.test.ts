/** Provider selection: which adapter a configured name resolves to. */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  ModelProviderError,
  PROVIDER_API_KEY_ENV,
  createModelClient,
  defaultModelFor,
  resolveModelProvider,
} from "./provider.js";

describe("resolveModelProvider", () => {
  it("defaults to Anthropic when configuration names none", () => {
    expect(resolveModelProvider("")).toBe(DEFAULT_MODEL_PROVIDER);
    expect(resolveModelProvider("   ")).toBe("anthropic");
  });

  it("accepts every supported provider, case- and space-insensitively", () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(resolveModelProvider(` ${provider.toUpperCase()} `)).toBe(provider);
    }
  });

  it("throws on an unknown name rather than falling back to the default", () => {
    expect(() => resolveModelProvider("wattson")).toThrow(ModelProviderError);
    // The message names what to use instead.
    expect(() => resolveModelProvider("wattson")).toThrow(/anthropic, openai/);
  });
});

describe("per-provider defaults", () => {
  it("gives every supported provider a default model and key variable", () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(defaultModelFor(provider)).not.toBe("");
      expect(PROVIDER_API_KEY_ENV[provider]).toMatch(/_API_KEY$/);
    }
  });
});

describe("createModelClient", () => {
  it("builds the adapter for the selected provider", () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(createModelClient({ provider, apiKey: "sk-test" }).provider).toBe(
        provider,
      );
    }
  });

  it("returns an independent client per call", () => {
    const first = createModelClient({ provider: "anthropic", apiKey: "sk-one" });
    const second = createModelClient({ provider: "anthropic", apiKey: "sk-two" });

    expect(first).not.toBe(second);
  });
});
