/**
 * The one definition of what a model call records as a trace.
 *
 * Both callers of AnthropicLike.messages.create — the review agents
 * here and the synthesiser in @pr-review/reviewer — want the same
 * generation observation around it: the same name, the same model and
 * token attributes, the same ERROR handling. Writing that twice split
 * the shape of the traces this feature exists to produce, so it lives
 * here, next to the seam it wraps.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  LangfuseGeneration,
  LangfuseGenerationAttributes,
} from "@langfuse/tracing";
import { errorMessage } from "@pr-review/logging";

/**
 * Any observation that can parent a generation. Structural rather than
 * a union of LangfuseAgent | LangfuseChain | ... so a caller can nest a
 * model call under whatever observation it already holds.
 */
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
 * Runs one Anthropic call as a `call-anthropic-model` generation under
 * `parent`, recording stop reason, block count, and token usage. The
 * observation is always ended, and a throw is recorded before it
 * propagates — the caller's own error handling is unchanged.
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
