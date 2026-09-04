/**
 * The one place the evaluations read model credentials. The key is never
 * stored, defaulted, or logged, and missing credentials fail fast.
 */
import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  apiKeyEnvFor,
  defaultModelFor,
  resolveModelProvider,
  type ModelProvider,
} from "@pr-review/ai";

/** Environment variable selecting the provider under evaluation. */
export const PROVIDER_ENV = "MODEL_PROVIDER";

/** Environment variable overriding the model under evaluation. */
export const MODEL_ENV = "MODEL_ID";

/**
 * Narrows which review agents the evaluations run, spelled like the
 * action's `agents` input. Expectations for an agent that no longer runs
 * will fail, and should.
 */
export const AGENTS_ENV = "REVIEW_AGENTS";

/** Model credentials for one evaluation run. */
export interface ModelAccess {
  provider: ModelProvider;
  apiKey: string;
  model: string;
}

/** The actionable message shown when the provider's API key is absent. */
export function missingApiKeyMessage(provider: ModelProvider): string {
  const keyEnv = apiKeyEnvFor(provider);
  return [
    `${keyEnv} is not set, so the agent evaluations cannot run against ${provider}.`,
    "",
    "These evaluations drive the real review pipeline against the fixtures in",
    "evals/fixtures, which means real model calls and real token spend. No model",
    "call was made and no fixture was evaluated.",
    "",
    "To run them, set the key in the environment and re-run:",
    "",
    `  export ${keyEnv}=…            # your ${provider} API key`,
    `  export ${PROVIDER_ENV}=…       # optional; ${MODEL_PROVIDERS.join(" | ")}, defaults to ${DEFAULT_MODEL_PROVIDER}`,
    `  export ${MODEL_ENV}=…          # optional; defaults to ${defaultModelFor(provider)}`,
    `  export ${AGENTS_ENV}=…         # optional; defaults to every review agent`,
    "  pnpm eval",
    "",
    "The fast unit suite (pnpm test) never calls a model and needs no key.",
  ].join("\n");
}

/** Throws missingApiKeyMessage when the provider's key is absent. */
export function requireModelAccess(
  env: Record<string, string | undefined>,
): ModelAccess {
  const provider = resolveModelProvider(env[PROVIDER_ENV]?.trim() ?? "");
  const apiKey = env[apiKeyEnvFor(provider)]?.trim() ?? "";
  if (apiKey === "") {
    throw new Error(missingApiKeyMessage(provider));
  }
  const model = env[MODEL_ENV]?.trim() ?? "";
  return {
    provider,
    apiKey,
    model: model === "" ? defaultModelFor(provider) : model,
  };
}
