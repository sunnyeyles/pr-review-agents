/**
 * Langfuse tracing for one action run.
 *
 * Only a tracer provider is registered — not the full OpenTelemetry
 * Node SDK. `@opentelemetry/sdk-node` would also pull in the metrics
 * and logs SDKs and every bundled OTLP/gRPC/Zipkin/Prometheus
 * exporter, none of which this action uses; since the action ships as
 * one fully inlined esbuild bundle, that weight is paid on every run
 * and committed to `dist/`.
 *
 * Spans are batched and flushed once at the end of the run rather than
 * exported one HTTPS request at a time. A review ends dozens of spans
 * — one per agent, per model turn, per tool call — and the caller
 * already awaits `forceFlush` before returning, which is the same
 * delivery guarantee immediate export would give, for one request
 * instead of dozens.
 *
 * Tracing is optional. When the Langfuse inputs are absent the action
 * never builds a runtime at all, and every observation in the pipeline
 * degrades to a no-op.
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface LangfuseRuntimeConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string | undefined;
  release?: string | undefined;
}

export interface LangfuseRuntime {
  forceFlush(): Promise<void>;
}

/** Starts span export for this process and returns its flush handle. */
export function createLangfuseRuntime(
  config: LangfuseRuntimeConfig,
): LangfuseRuntime {
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    release: config.release,
  });

  new NodeTracerProvider({ spanProcessors: [spanProcessor] }).register();

  return {
    async forceFlush() {
      await spanProcessor.forceFlush();
    },
  };
}
