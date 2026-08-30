/**
 * The Anthropic model client seam — the slice of the SDK the agents
 * consume. The model id always arrives via configuration.
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
