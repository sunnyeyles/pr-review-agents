/**
 * Token-usage accounting for model calls. Four counters, not two: where a
 * provider caches, `inputTokens` is only the uncached remainder and the
 * three input counters bill differently.
 */
import type { ModelUsage } from "./model/types.js";

/** Aggregated token usage of one model-calling unit of work. */
export type TokenUsage = ModelUsage;

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
  usage: ModelUsage,
): TokenUsage {
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    cacheCreationInputTokens:
      total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    cacheReadInputTokens:
      total.cacheReadInputTokens + usage.cacheReadInputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
  };
}
