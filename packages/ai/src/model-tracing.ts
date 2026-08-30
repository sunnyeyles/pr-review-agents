/**
 * The one definition of what a model call records as a trace, shared by
 * the review agents and the synthesiser.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  LangfuseGeneration,
  LangfuseGenerationAttributes,
} from "@langfuse/tracing";
import { errorMessage } from "@pr-review/logging";

/** Structural, so a caller can nest a model call under any observation it holds. */
export interface GenerationParent {
  startObservation(
    name: string,
    attributes: LangfuseGenerationAttributes,
    options: { asType: "generation" },
  ): LangfuseGeneration;
}

export interface ModelCallTrace {
  model: string;
  /** Call-shape counts. Never message content — see the logging rules. */
  input: Record<string, unknown>;
  maxTokens: number;
}

/**
 * Runs one Anthropic call as a generation under `parent`. The
 * observation is always ended, and a throw is recorded before it propagates.
 */
export async function traceModelCall(
  parent: GenerationParent,
  trace: ModelCallTrace,
  call: () => Promise<Anthropic.Messages.Message>,
): Promise<Anthropic.Messages.Message> {
  const generation = parent.startObservation(
    "call-anthropic-model",
    {
      model: trace.model,
      input: trace.input,
      modelParameters: { maxTokens: trace.maxTokens },
    },
    { asType: "generation" },
  );
  try {
    const response = await call();
    generation.update({
      output: {
        stopReason: response.stop_reason,
        contentBlockCount: response.content.length,
      },
      usageDetails: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
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
