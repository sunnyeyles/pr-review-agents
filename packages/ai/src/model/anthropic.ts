/**
 * The Anthropic adapter for the neutral model seam. The model id always
 * arrives via configuration; nothing here hard-codes one.
 */
import Anthropic from "@anthropic-ai/sdk";

import type {
  ModelClient,
  ModelContentBlock,
  ModelMessage,
  ModelResponse,
  ModelUsage,
} from "./types.js";

export const ANTHROPIC_PROVIDER = "anthropic";

/** The slice of the Anthropic SDK this adapter consumes. */
export interface AnthropicSdkLike {
  messages: {
    create(
      params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Messages.Message>;
  };
}

export interface AnthropicClientConfig {
  apiKey: string;
  /** Points the SDK at a gateway or proxy speaking the Anthropic API. */
  baseUrl?: string | undefined;
  /** Injected by the tests; defaults to the real SDK client. */
  sdk?: AnthropicSdkLike | undefined;
}

// Marks the cache breakpoint. Nothing above it may vary between turns,
// or the cache stops hitting silently.
const CACHE_CONTROL = { type: "ephemeral" } as const;

function toAnthropicBlock(
  block: ModelContentBlock,
): Anthropic.Messages.ContentBlockParam | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "provider":
      // Thinking must go back unchanged, or the API rejects the turn.
      return block.provider === ANTHROPIC_PROVIDER
        ? (block.block as Anthropic.Messages.ContentBlockParam)
        : undefined;
  }
}

function toAnthropicMessages(
  messages: readonly ModelMessage[],
): Anthropic.Messages.MessageParam[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content
          .map(toAnthropicBlock)
          .filter((block) => block !== undefined),
      };
    }
    if (typeof message.content === "string") {
      return { role: "user", content: message.content };
    }
    return {
      role: "user",
      content: message.content.map((block) => ({
        type: "tool_result" as const,
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError === true ? { is_error: true } : {}),
      })),
    };
  });
}

function fromAnthropicContent(
  content: readonly Anthropic.Messages.ContentBlock[],
): ModelContentBlock[] {
  const blocks: ModelContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      blocks.push({ type: "provider", provider: ANTHROPIC_PROVIDER, block });
    }
  }
  return blocks;
}

function fromAnthropicUsage(usage: Anthropic.Messages.Usage): ModelUsage {
  return {
    inputTokens: usage.input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}

/** Builds an Anthropic-backed ModelClient for the injected API key. */
export function createAnthropicClient(
  config: AnthropicClientConfig,
): ModelClient {
  const sdk: AnthropicSdkLike =
    config.sdk ??
    new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    });

  return {
    provider: ANTHROPIC_PROVIDER,
    async createMessage(request) {
      const cache = request.cachePrefix === true;
      const response = await sdk.messages.create({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        // Top-level marker: caches the conversation tail for the next turn.
        ...(cache ? { cache_control: CACHE_CONTROL } : {}),
        // Tools are sent ahead of the system prompt, so one breakpoint on
        // the system block caches both.
        system: [
          {
            type: "text",
            text: request.system,
            ...(cache ? { cache_control: CACHE_CONTROL } : {}),
          },
        ],
        ...(request.tools === undefined
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema:
                  tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
              })),
            }),
        messages: toAnthropicMessages(request.messages),
      });
      return {
        content: fromAnthropicContent(response.content),
        stopReason: response.stop_reason ?? undefined,
        usage: fromAnthropicUsage(response.usage),
      } satisfies ModelResponse;
    },
  };
}
