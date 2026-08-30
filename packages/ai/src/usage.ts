/**
 * Token-usage accounting for model calls. Four counters, not two: with
 * caching, `input_tokens` is only the uncached remainder and the three
 * input counters bill differently.
 */
import type Anthropic from "@anthropic-ai/sdk";

/** Aggregated token usage of one model-calling unit of work. */
export interface TokenUsage {
  /** Input tokens processed at full price — the uncached remainder. */
  inputTokens: number;
  /** Input tokens written to the cache this run (~1.25x input price). */
  cacheCreationInputTokens: number;
  /** Input tokens served from the cache this run (~0.1x input price). */
  cacheReadInputTokens: number;
  outputTokens: number;
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  };
}

/** Adds one response's usage block to a running total. */
export function addTokenUsage(
  total: TokenUsage,
  usage: Anthropic.Messages.Usage,
): TokenUsage {
  return {
    inputTokens: total.inputTokens + usage.input_tokens,
    cacheCreationInputTokens:
      total.cacheCreationInputTokens + (usage.cache_creation_input_tokens ?? 0),
    cacheReadInputTokens:
      total.cacheReadInputTokens + (usage.cache_read_input_tokens ?? 0),
    outputTokens: total.outputTokens + usage.output_tokens,
  };
}
