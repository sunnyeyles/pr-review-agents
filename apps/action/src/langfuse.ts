/**
 * Langfuse tracing for one action run.
 *
 * Spans are exported immediately rather than batched: an action step is
 * a short-lived process that exits as soon as the review is published,
 * so a batching window would routinely outlive the process that filled
 * it. `forceFlush` exists for the same reason — the caller flushes
 * before returning so nothing is lost on the way out.
 *
 * Tracing is optional. When the Langfuse inputs are absent the action
 * never builds a runtime at all, and every observation in the pipeline
 * degrades to a no-op.
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

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
    exportMode: "immediate",
  });

  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();

  return {
    async forceFlush() {
      await spanProcessor.forceFlush();
    },
  };
}
