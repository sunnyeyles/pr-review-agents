/**
 * The one place the evaluations read model credentials. The key is never
 * stored, defaulted, or logged, and missing credentials fail fast.
 */

/** Environment variable holding the Anthropic API key. */
export const API_KEY_ENV = "ANTHROPIC_API_KEY";

/** Environment variable overriding the model under evaluation. */
export const MODEL_ENV = "ANTHROPIC_MODEL";

/**
 * Narrows which review agents the evaluations run, spelled like the
 * action's `agents` input. Expectations for an agent that no longer runs
 * will fail, and should.
 */
export const AGENTS_ENV = "REVIEW_AGENTS";

/** Mirrors the default of the action's `model` input. */
export const DEFAULT_MODEL = "claude-sonnet-5";

/** Model credentials for one evaluation run. */
export interface ModelAccess {
  apiKey: string;
  model: string;
}

/** The actionable message shown when the API key is absent. */
export const MISSING_API_KEY_MESSAGE = [
  `${API_KEY_ENV} is not set, so the agent evaluations cannot run.`,
  "",
  "These evaluations drive the real review pipeline against the fixtures in",
  "evals/fixtures, which means real model calls and real token spend. No model",
  "call was made and no fixture was evaluated.",
  "",
  "To run them, set the key in the environment and re-run:",
  "",
  `  export ${API_KEY_ENV}=…        # your Anthropic API key`,
  `  export ${MODEL_ENV}=…          # optional; defaults to ${DEFAULT_MODEL}`,
  `  export ${AGENTS_ENV}=…         # optional; defaults to every review agent`,
  "  pnpm eval",
  "",
  "The fast unit suite (pnpm test) never calls a model and needs no key.",
].join("\n");

/** Throws MISSING_API_KEY_MESSAGE when the key is absent. */
export function requireModelAccess(
  env: Record<string, string | undefined>,
): ModelAccess {
  const apiKey = env[API_KEY_ENV]?.trim() ?? "";
  if (apiKey === "") {
    throw new Error(MISSING_API_KEY_MESSAGE);
  }
  const model = env[MODEL_ENV]?.trim() ?? "";
  return { apiKey, model: model === "" ? DEFAULT_MODEL : model };
}
