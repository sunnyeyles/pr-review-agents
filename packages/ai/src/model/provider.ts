/**
 * Provider selection. The one place that knows which adapters exist, so
 * adding a provider is an entry in PROVIDERS and nothing else.
 */
import { createAnthropicClient, ANTHROPIC_PROVIDER } from "./anthropic.js";
import { createOpenAiClient, OPENAI_PROVIDER } from "./openai.js";
import type { ModelClient } from "./types.js";

interface ProviderEntry {
  /** Used when configuration names no model. */
  defaultModel: string;
  /** Environment variable this provider's key conventionally arrives in. */
  apiKeyEnv: string;
  create(options: { apiKey: string; baseUrl?: string | undefined }): ModelClient;
}

const PROVIDERS = {
  [ANTHROPIC_PROVIDER]: {
    defaultModel: "claude-sonnet-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    create: createAnthropicClient,
  },
  [OPENAI_PROVIDER]: {
    defaultModel: "gpt-5",
    apiKeyEnv: "OPENAI_API_KEY",
    create: createOpenAiClient,
  },
} as const satisfies Record<string, ProviderEntry>;

export type ModelProvider = keyof typeof PROVIDERS;

export const MODEL_PROVIDERS = Object.keys(PROVIDERS) as ModelProvider[];

/** The provider used when configuration names none. */
export const DEFAULT_MODEL_PROVIDER: ModelProvider = ANTHROPIC_PROVIDER;

/** An unusable provider selection, raised before any model call. */
export class ModelProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderError";
  }
}

function isModelProvider(name: string): name is ModelProvider {
  return Object.hasOwn(PROVIDERS, name);
}

/** Empty selects the default; an unknown name throws rather than falling back. */
export function resolveModelProvider(selection: string): ModelProvider {
  const name = selection.trim().toLowerCase();
  if (name === "") {
    return DEFAULT_MODEL_PROVIDER;
  }
  if (!isModelProvider(name)) {
    throw new ModelProviderError(
      `Unknown model provider: ${selection.trim()}. Use one of ${MODEL_PROVIDERS.join(", ")}.`,
    );
  }
  return name;
}

export function defaultModelFor(provider: ModelProvider): string {
  return PROVIDERS[provider].defaultModel;
}

export function apiKeyEnvFor(provider: ModelProvider): string {
  return PROVIDERS[provider].apiKeyEnv;
}

export interface ModelClientConfig {
  provider: ModelProvider;
  apiKey: string;
  /** Gateway, proxy, or compatible endpoint; the SDK default when absent. */
  baseUrl?: string | undefined;
}

/** Builds the ModelClient for a configured provider. */
export function createModelClient(config: ModelClientConfig): ModelClient {
  return PROVIDERS[config.provider].create({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}
