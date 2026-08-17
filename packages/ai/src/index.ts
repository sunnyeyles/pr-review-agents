/**
 * @pr-review/ai
 *
 * The Anthropic side of the review system: the SDK client seam (model
 * configured via ANTHROPIC_MODEL, key injected by the caller), the six
 * read-only repository-scoped agent tools, the shared agent runtime
 * (one agentic loop), and the three review lenses — Correctness,
 * Security, Architecture — built on it. Agents only ever PROPOSE
 * findings; publishing belongs to the deterministic pipeline in
 * @pr-review/reviewer and the worker.
 */
export {
  createAnthropicClient,
  type AnthropicClientConfig,
  type AnthropicLike,
} from "./anthropic.js";
export {
  extractAgentOutput,
  type AgentOutput,
  type AgentOutputResult,
} from "./agent-output.js";
export type { ReviewAgent, ReviewContext } from "./review-types.js";
export { addTokenUsage, emptyTokenUsage, type TokenUsage } from "./usage.js";
export {
  AgentRunError,
  createReviewAgent,
  type ReviewAgentDeps,
  type ReviewLens,
} from "./agent-runtime.js";
export {
  architectureLens,
  correctnessLens,
  createReviewAgents,
  reviewLenses,
  securityLens,
} from "./agents.js";
