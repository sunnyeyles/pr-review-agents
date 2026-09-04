/**
 * The OpenAI adapter for the neutral model seam, over Chat Completions.
 * A `baseUrl` also points it at any OpenAI-compatible endpoint.
 */
import OpenAI from "openai";

import { messageText } from "./types.js";
import type {
  ModelClient,
  ModelContentBlock,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "./types.js";

export const OPENAI_PROVIDER = "openai";

/** The slice of the OpenAI SDK this adapter consumes. */
export interface OpenAiSdkLike {
  chat: {
    completions: {
      create(
        params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

export interface OpenAiClientConfig {
  apiKey: string;
  /** Points the SDK at Azure, a gateway, or any OpenAI-compatible server. */
  baseUrl?: string | undefined;
  /** Injected by the tests; defaults to the real SDK client. */
  sdk?: OpenAiSdkLike | undefined;
}

/** A tool result is its own message here, so one turn can expand to several. */
function toOpenAiMessages(
  system: string,
  messages: readonly ModelMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        out.push({ role: "user", content: message.content });
        continue;
      }
      for (const block of message.content) {
        out.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          // The API has no error flag on a tool message, so a failure is
          // labelled in the content the model reads.
          content: block.isError === true ? `Error: ${block.content}` : block.content,
        });
      }
      continue;
    }

    const text = messageText(message.content);
    const toolCalls = message.content
      .filter(
        (block): block is Extract<ModelContentBlock, { type: "tool_use" }> =>
          block.type === "tool_use",
      )
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }));
    out.push({
      role: "assistant",
      content: text === "" ? null : text,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    });
  }
  return out;
}

/** Unparseable arguments are passed through: tool input validation rejects them. */
function parseToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
}

function fromOpenAiMessage(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): ModelContentBlock[] {
  const blocks: ModelContentBlock[] = [];
  if (message.content !== null && message.content !== "") {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") {
      continue;
    }
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    });
  }
  return blocks;
}

/**
 * `prompt_tokens` counts cached tokens too, unlike Anthropic's, so the
 * cached share is subtracted to keep `inputTokens` the uncached remainder.
 * OpenAI caches implicitly and never reports a cache write.
 */
function fromOpenAiUsage(
  usage: OpenAI.Completions.CompletionUsage | undefined,
): ModelUsage {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max((usage?.prompt_tokens ?? 0) - cacheRead, 0),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cacheRead,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

/** Builds an OpenAI-backed ModelClient for the injected API key. */
export function createOpenAiClient(config: OpenAiClientConfig): ModelClient {
  const sdk: OpenAiSdkLike =
    config.sdk ??
    new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    });

  return {
    provider: OPENAI_PROVIDER,
    async createMessage(request) {
      const completion = await sdk.chat.completions.create({
        model: request.model,
        max_completion_tokens: request.maxOutputTokens,
        messages: toOpenAiMessages(request.system, request.messages),
        ...(request.tools === undefined
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }),
      });
      const choice = completion.choices[0];
      if (choice === undefined) {
        throw new Error("OpenAI returned no completion choices");
      }
      return {
        content: fromOpenAiMessage(choice.message),
        stopReason: choice.finish_reason,
        usage: fromOpenAiUsage(completion.usage),
      } satisfies ModelResponse;
    },
  };
}
