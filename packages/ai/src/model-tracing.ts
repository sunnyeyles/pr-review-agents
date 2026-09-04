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
      // Four counters, not two: where a provider caches, `input` is only
      // the uncached remainder, and Langfuse prices the cache keys separately.
      usageDetails: {
        input: response.usage.inputTokens,
        output: response.usage.outputTokens,
        cache_read_input_tokens: response.usage.cacheReadInputTokens,
        cache_creation_input_tokens: response.usage.cacheCreationInputTokens,
      },
    });
    return response;
  } catch (error) {
    generation.update({ level: "ERROR", statusMessage: errorMessage(error) });
    throw error;
  } finally {
    generation.end();
  }
}
