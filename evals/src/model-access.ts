/**
 * The one place the evaluations read model credentials.
 *
 * Evaluations measure review quality, which means they call the real
 * Anthropic API and spend real tokens. The key is never stored, never
 * defaulted, and never logged: it arrives in the environment, exactly
 * as it does for the action itself (where it is a repository secret
 * passed as an action input).
 *
 * Missing credentials fail fast, before any fixture is loaded and
 * before any client is built, so the failure is one clear message
 * rather than three timed-out agent runs.
 */

/** Environment variable holding the Anthropic API key. */
export const API_KEY_ENV = "ANTHROPIC_API_KEY";

/** Environment variable overriding the model under evaluation. */
export const MODEL_ENV = "ANTHROPIC_MODEL";

/**
 * The model evaluated when MODEL_ENV is unset. It mirrors the default
 * of the action's `model` input (apps/action/action.yml), so a bare
 * `pnpm eval` measures what a user gets out of the box; set MODEL_ENV
 * to evaluate any other model.
 */
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
  "  pnpm eval",
  "",
  "The fast unit suite (pnpm test) never calls a model and needs no key.",
].join("\n");

/**
 * Reads model credentials from the environment, or throws with
 * MISSING_API_KEY_MESSAGE when the key is absent.
 */
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
