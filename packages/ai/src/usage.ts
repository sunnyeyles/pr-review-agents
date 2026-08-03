/**
 * Token-usage accounting for model calls (spec §26 observability):
 * every Anthropic response carries a `usage` block; the agent runtime
 * aggregates it across the turns of one agent run, and the Synthesiser
 * reports it for its single call, so agent.completed /
 * synthesis.completed events can say what a review cost in tokens.
 */
import type Anthropic from "@anthropic-ai/sdk";

/** Aggregated token usage of one model-calling unit of work. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

/** Adds one Anthropic response's usage block to a running total. */
export function addTokenUsage(
  total: TokenUsage,
  usage: Anthropic.Messages.Usage,
): TokenUsage {
  return {
    inputTokens: total.inputTokens + usage.input_tokens,
    outputTokens: total.outputTokens + usage.output_tokens,
  };
}
