/**
 * The one definition of what a model call records as a trace, shared by
 * the review agents and the synthesiser.
 */
import type {
  LangfuseGeneration,
  LangfuseGenerationAttributes,
} from "@langfuse/tracing";
import { errorMessage } from "@pr-review/logging";

import type { ModelResponse } from "./model/types.js";

// Langfuse prices by key, and each provider spells its cache keys differently.
const CACHE_USAGE_KEYS: Record<string, { read: string; creation?: string }> = {
  openai: { read: "input_cached_tokens" },
};
const DEFAULT_CACHE_USAGE_KEYS = {
  read: "cache_read_input_tokens",
  creation: "cache_creation_input_tokens",
};

function usageDetails(
  provider: string,
  usage: ModelResponse["usage"],
): Record<string, number> {
  const keys = CACHE_USAGE_KEYS[provider] ?? DEFAULT_CACHE_USAGE_KEYS;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    [keys.read]: usage.cacheReadInputTokens,
    ...(keys.creation === undefined
      ? {}
      : { [keys.creation]: usage.cacheCreationInputTokens }),
  };
}

/** Structural, so a caller can nest a model call under any observation it holds. */
export interface GenerationParent {
  startObservation(
    name: string,
    attributes: LangfuseGenerationAttributes,
    options: { asType: "generation" },
  ): LangfuseGeneration;
}

export interface ModelCallTrace {
  provider: string;
  model: string;
  /** Call-shape counts. Never message content — see the logging rules. */
  input: Record<string, unknown>;
  maxTokens: number;
}

/**
 * Runs one model call as a generation under `parent`. The observation is
 * always ended, and a throw is recorded before it propagates.
 */
export async function traceModelCall(
  parent: GenerationParent,
  trace: ModelCallTrace,
  call: () => Promise<ModelResponse>,
): Promise<ModelResponse> {
  const generation = parent.startObservation(
    "call-model",
    {
      model: trace.model,
      input: trace.input,
      modelParameters: { maxTokens: trace.maxTokens },
      metadata: { provider: trace.provider },
    },
    { asType: "generation" },
  );
  try {
    const response = await call();
    generation.update({
      output: {
        stopReason: response.stopReason,
        contentBlockCount: response.content.length,
      },
      usageDetails: usageDetails(trace.provider, response.usage),
    });
    return response;
  } catch (error) {
    generation.update({ level: "ERROR", statusMessage: errorMessage(error) });
    throw error;
  } finally {
    generation.end();
  }
}
