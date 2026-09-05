/**
 * Langfuse tracing for one action run. Only a tracer provider is registered:
 * the full OpenTelemetry Node SDK would ship unused exporters in the bundle.
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

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
  // From v7 the SDK emits spans only to a registered integration.
  registerTelemetry(new LangfuseVercelAiSdkIntegration());

  return {
    async forceFlush() {
      await spanProcessor.forceFlush();
    },
  };
}
