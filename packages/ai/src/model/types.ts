/**
 * The provider-neutral model seam. Everything above it speaks these types only,
 * so a new provider is one adapter and no other changes.
 */

export interface ModelTextBlock {
  type: "text";
  text: string;
}

export interface ModelToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** Provider state replayed verbatim next turn, e.g. Anthropic thinking. */
interface ModelProviderBlock {
  type: "provider";
  provider: string;
  block: unknown;
}

/** What a model can produce. Providers map their own blocks onto these. */
export type ModelContentBlock =
  | ModelTextBlock
  | ModelToolUseBlock
  | ModelProviderBlock;

/** The concatenated text of one message's content blocks. */
export function messageText(content: readonly ModelContentBlock[]): string {
  return content
    .filter((block): block is ModelTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface ModelToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ModelMessage =
  | { role: "user"; content: string | readonly ModelToolResultBlock[] }
  | { role: "assistant"; content: readonly ModelContentBlock[] };

/** A tool as the model sees it; `inputSchema` is JSON Schema. */
export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  maxOutputTokens: number;
  system: string;
  messages: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  /** Cache this request as the next turn's prefix, where the provider can. */
  cachePrefix?: boolean;
}

/**
 * Four counters, not two: where a provider caches, `inputTokens` is only the
 * uncached remainder and the three input counters bill differently.
 */
export interface ModelUsage {
  /** Input tokens processed at full price — the uncached remainder. */
  inputTokens: number;
  /** Input tokens written to the cache this call. */
  cacheCreationInputTokens: number;
  /** Input tokens served from the cache this call. */
  cacheReadInputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  content: readonly ModelContentBlock[];
  /** The provider's own stop reason, verbatim; absent when it reports none. */
  stopReason: string | undefined;
  usage: ModelUsage;
}

/** The whole of what the review system needs from a model provider. */
export interface ModelClient {
  /** Provider id, for logs and traces. Never a credential. */
  readonly provider: string;
  createMessage(request: ModelRequest): Promise<ModelResponse>;
}
