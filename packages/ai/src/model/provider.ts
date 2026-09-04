/**
 * Provider selection. The one place that knows which adapters exist, so
 * adding a provider is an entry here and nothing else.
 */
import { createAnthropicClient, ANTHROPIC_PROVIDER } from "./anthropic.js";
import { createOpenAiClient, OPENAI_PROVIDER } from "./openai.js";
import type { ModelClient } from "./types.js";

export const MODEL_PROVIDERS = [ANTHROPIC_PROVIDER, OPENAI_PROVIDER] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The provider used when configuration names none. */
export const DEFAULT_MODEL_PROVIDER: ModelProvider = ANTHROPIC_PROVIDER;

/** Per-provider default model id, used when configuration names none. */
const DEFAULT_MODELS: Readonly<Record<ModelProvider, string>> = {
  [ANTHROPIC_PROVIDER]: "claude-sonnet-5",
  [OPENAI_PROVIDER]: "gpt-5",
};

/** Environment variable each provider's key conventionally arrives in. */
export const PROVIDER_API_KEY_ENV: Readonly<Record<ModelProvider, string>> = {
  [ANTHROPIC_PROVIDER]: "ANTHROPIC_API_KEY",
  [OPENAI_PROVIDER]: "OPENAI_API_KEY",
};

/** An unusable provider selection, raised before any model call. */
export class ModelProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderError";
  }
}

/** Empty selects the default; an unknown name throws rather than falling back. */
export function resolveModelProvider(selection: string): ModelProvider {
  const name = selection.trim().toLowerCase();
  if (name === "") {
    return DEFAULT_MODEL_PROVIDER;
  }
  const provider = MODEL_PROVIDERS.find((candidate) => candidate === name);
  if (provider === undefined) {
    throw new ModelProviderError(
      `Unknown model provider: ${selection.trim()}. Use one of ${MODEL_PROVIDERS.join(", ")}.`,
    );
  }
  return provider;
}

export function defaultModelFor(provider: ModelProvider): string {
  return DEFAULT_MODELS[provider];
}

export interface ModelClientConfig {
  provider: ModelProvider;
  apiKey: string;
  /** Gateway, proxy, or compatible endpoint; the SDK default when absent. */
  baseUrl?: string | undefined;
}

/** Builds the ModelClient for a configured provider. */
export function createModelClient(config: ModelClientConfig): ModelClient {
  const options = { apiKey: config.apiKey, baseUrl: config.baseUrl };
  switch (config.provider) {
    case ANTHROPIC_PROVIDER:
      return createAnthropicClient(options);
    case OPENAI_PROVIDER:
      return createOpenAiClient(options);
  }
}
