/**
 * The Anthropic model client seam. The agents consume only this slice
 * of the official SDK; the real SDK satisfies it structurally and
 * tests inject scripted fakes so no model calls happen in tests.
 *
 * The model id is NEVER hard-coded: it always arrives via
 * configuration (the ANTHROPIC_MODEL environment variable â€).
 */
import Anthropic from "@anthropic-ai/sdk";

/** The slice of the Anthropic SDK the review agents consume. */
export interface AnthropicLike {
  messages: {
    create(
      params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Messages.Message>;
  };
}

export interface AnthropicClientConfig {
  apiKey: string;
}

/** Builds a real Anthropic SDK client for the injected API key. */
export function createAnthropicClient(config: AnthropicClientConfig): AnthropicLike {
  return new Anthropic({ apiKey: config.apiKey });
}
