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
export type { ReviewAgent, ReviewContext } from "./review-types.js";
export { addTokenUsage, emptyTokenUsage, type TokenUsage } from "./usage.js";
export {
  AgentRunError,
  createReviewAgent,
  type ReviewAgentDeps,
  type ReviewSystemPrompts,
} from "./agents/runtime.js";
export {
  ALL_LENSES,
  SYNTHESIS_PROMPT_ID,
  buildReviewSystemPrompt,
  lensPromptKey,
  reviewLensSchema,
  type ReviewLens,
} from "./agents/lens.js";
export {
  createReviewAgents,
  resolveReviewLenses,
} from "./agents/lens-set.js";
export {
  DEFAULT_LENS_CONFIG_PATH,
  LensConfigError,
  loadLensSet,
  missingConfigMessage,
  parseLensConfig,
  type LensConfig,
  type LoadLensSetOptions,
  type ReadOptionalFile,
} from "./lens-config.js";
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
  managedPromptKeys,
  promptContractProblems,
  reviewPromptContractProblems,
  type LangfusePromptClient,
  type LangfusePromptClientConfig,
  type LoadManagedPromptsOptions,
  type LoadPromptsResult,
  type ManagedPromptId,
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
} from "./prompt-seed.js";
export {
  traceModelCall,
  type GenerationParent,
  type ModelCallTrace,
} from "./model-tracing.js";
