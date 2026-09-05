/**
 * The one definition of what a review run records as a trace. Every
 * observation an agent or the synthesiser opens inside `work` nests under
 * this root span, so the run has a single trace id human feedback can
 * be scored against.
 */
import { startActiveObservation } from "@langfuse/tracing";

export const REVIEW_TRACE_NAME = "review-pull-request";

export interface ReviewTraceOptions<T> {
  input: Record<string, unknown>;
  /** What of the result the root span records as its output. */
  output: (result: T) => Record<string, unknown>;
}

export interface TracedReview<T> {
  result: T;
  /** Unset when no tracer is registered, so nothing can score the run. */
  traceId: string | undefined;
}

export function traceReview<T>(
  options: ReviewTraceOptions<T>,
  work: () => Promise<T>,
): Promise<TracedReview<T>> {
  return startActiveObservation(
    REVIEW_TRACE_NAME,
    async (span) => {
      span.update({ input: options.input });
      const result = await work();
      span.update({ output: options.output(result) });
      return {
        result,
        traceId: span.otelSpan.isRecording() ? span.traceId : undefined,
      };
    },
    { asType: "chain" },
  );
}
