/**
 * The Anthropic side of the review system: the client seam, prompt
 * management, and the model-calling units under `agents/`. Agents only
 * propose findings; publishing lives in @pr-review/reviewer.
 */
export {
  createAnthropicClient,
  type AnthropicClientConfig,
  type AnthropicLike,
} from "./anthropic.js";
export {
  extractAgentOutput,
  messageText,
  type AgentOutputResult,
} from "./agents/output.js";
export type { ReviewAgent, ReviewContext } from "./agent-contract.js";
export { addTokenUsage, emptyTokenUsage, type TokenUsage } from "./usage.js";
export {
  AgentRunError,
  createReviewAgent,
  type ReviewAgentDeps,
  type ReviewSystemPrompts,
} from "./agents/runtime.js";
export {
  ALL_AGENTS,
  SYNTHESIS_PROMPT_ID,
  type AgentDefinition,
} from "./agents/definition.js";
export {
  createReviewAgents,
  resolveAgentDefinitions,
} from "./agents/agent-set.js";
export {
  DEFAULT_AGENT_CONFIG_PATH,
  AgentConfigError,
  loadAgentDefinitions,
  parseAgentConfig,
  type LoadAgentDefinitionsOptions,
  type ReadOptionalFile,
} from "./agents/config.js";
export {
  SynthesisError,
  buildSynthesisSystemPrompt,
  createSynthesiser,
  type SynthesisResult,
  type Synthesiser,
  type SynthesiserDeps,
} from "./agents/synthesiser.js";
export {
  DEFAULT_LANGFUSE_BASE_URL,
  DEFAULT_PROMPT_LABEL,
  createLangfusePromptClient,
  inCodePrompts,
  loadManagedPrompts,
  promptContractProblems,
  reviewPromptContractProblems,
  type LangfusePromptClient,
  type LangfusePromptClientConfig,
  type LoadManagedPromptsOptions,
  type LoadPromptsResult,
  type ManagedPrompts,
  type PromptSource,
} from "./prompts.js";
export {
  createLangfusePromptWriter,
  seedFailed,
  seedManagedPrompts,
  type LabelledPrompt,
  type LangfusePromptWriter,
  type SeedManagedPromptsOptions,
  type SeedOutcome,
  type SeedReport,
} from "./seed-prompts.js";
export {
  traceModelCall,
  type GenerationParent,
  type ModelCallTrace,
} from "./model-tracing.js";
export {
  FEEDBACK_SCORE_NAME,
  createLangfuseScoreSink,
  type FeedbackScore,
  type FeedbackScoreSink,
} from "./feedback-scores.js";
