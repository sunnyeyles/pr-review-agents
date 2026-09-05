// Token-usage accounting for model calls. Four counters, not two: where a
// provider caches, the three input counters bill differently.
import type { LanguageModelUsage } from "ai";

/** Aggregated token usage of one model-calling unit of work. */
export interface TokenUsage {
  /** Input tokens processed at full price — the uncached remainder. */
  inputTokens: number;
  /** Input tokens written to the cache. */
  cacheCreationInputTokens: number;
  /** Input tokens served from the cache. */
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

/** Maps the SDK's usage onto our counters; its `inputTokens` is the total. */
export function toTokenUsage(usage: LanguageModelUsage): TokenUsage {
  const cacheReadInputTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheCreationInputTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const uncached =
    usage.inputTokenDetails.noCacheTokens ??
    (usage.inputTokens ?? 0) - cacheReadInputTokens - cacheCreationInputTokens;
  return {
    inputTokens: Math.max(0, uncached),
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens: usage.outputTokens ?? 0,
  };
}

/** Adds one response's usage to a running total. */
export function addTokenUsage(
  total: TokenUsage,
  usage: TokenUsage,
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
