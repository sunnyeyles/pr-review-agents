/**
 * The model side of the review system: the provider-neutral client seam,
 * prompt management, and the model-calling units under `agents/`. Agents
 * only propose findings; publishing lives in @pr-review/reviewer.
 *
 * A name reaches this barrel when something outside the package imports
 * it; everything else stays reachable by its own module path.
 */
export {
  createModelClient,
  defaultModelFor,
  resolveModelProvider,
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  ModelProviderError,
  apiKeyEnvFor,
  type ModelClientConfig,
  type ModelProvider,
} from "./model/provider.js";
export type { ModelClient } from "./model/types.js";
export type { ReviewAgent, ReviewContext } from "./agent-contract.js";
export { emptyTokenUsage, type TokenUsage } from "./usage.js";
export { AgentRunError, createReviewAgent } from "./agents/runtime.js";
export {
  SYNTHESIS_PROMPT_ID,
  type AgentDefinition,
} from "./agents/definition.js";
export {
  createReviewAgents,
  gateAgentsByPaths,
  resolveAgentDefinitions,
  type SkippedAgent,
} from "./agents/agent-set.js";
export {
  DEFAULT_AGENT_CONFIG_PATH,
  loadAgentDefinitions,
  type ReadOptionalFile,
} from "./agents/config.js";
export {
  SynthesisError,
  buildSynthesisSystemPrompt,
  createSynthesiser,
  type Synthesiser,
} from "./agents/synthesiser.js";
export {
  DEFAULT_LANGFUSE_BASE_URL,
  DEFAULT_PROMPT_LABEL,
  createLangfusePromptClient,
  inCodePrompts,
  loadManagedPrompts,
  type LangfusePromptClient,
  type LangfusePromptClientConfig,
  type ManagedPrompts,
} from "./prompts.js";
export {
  createLangfusePromptWriter,
  seedFailed,
  seedManagedPrompts,
  type LangfusePromptWriter,
} from "./seed-prompts.js";
