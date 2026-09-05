/** Provider selection: which model a configured name resolves to. */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  ModelProviderError,
  apiKeyEnvFor,
  createLanguageModel,
  defaultModelFor,
  resolveModelProvider,
} from "./model.js";

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
      expect(apiKeyEnvFor(provider)).toMatch(/_API_KEY$/);
    }
  });
});

describe("createLanguageModel", () => {
  it("builds a model bound to the configured id for every provider", () => {
    for (const provider of MODEL_PROVIDERS) {
      const model = createLanguageModel({
        provider,
        apiKey: "sk-test",
        modelId: defaultModelFor(provider),
      });
      expect(model.modelId).toBe(defaultModelFor(provider));
      expect(model.provider).toContain(provider);
    }
  });

  it("returns an independent model per call", () => {
    const config = {
      provider: "anthropic" as const,
      modelId: "claude-test-model",
    };
    const first = createLanguageModel({ ...config, apiKey: "sk-one" });
    const second = createLanguageModel({ ...config, apiKey: "sk-two" });

    expect(first).not.toBe(second);
  });

  it("makes no request at construction", () => {
    expect(() =>
      createLanguageModel({
        provider: "openai",
        apiKey: "sk-test",
        baseUrl: "https://gateway.example/v1",
        modelId: "gpt-test-model",
      }),
    ).not.toThrow();
  });
});
