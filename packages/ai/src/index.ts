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
import { GITHUB_PACKAGE } from "@pr-review/github";
import { SCHEMAS_PACKAGE } from "@pr-review/schemas";

export const AI_PACKAGE = "@pr-review/ai";

export const aiPackageDependencies = [SCHEMAS_PACKAGE, GITHUB_PACKAGE] as const;

export {
  createAnthropicClient,
  type AnthropicClientConfig,
  type AnthropicLike,
} from "./anthropic.js";
export {
  agentOutputSchema,
  extractAgentOutput,
  type AgentOutput,
  type AgentOutputResult,
} from "./agent-output.js";
export type { ReviewAgent, ReviewContext } from "./review-types.js";
export {
  MAX_TOOL_RESULT_CHARS,
  dispatchReviewTool,
  reviewTools,
  type ReviewTool,
  type ReviewToolInputSchema,
  type ReviewToolScope,
  type ToolDispatchResult,
} from "./tools.js";
export {
  AgentRunError,
  DEFAULT_MAX_TURNS,
  buildOpeningMessage,
  buildReviewSystemPrompt,
  createReviewAgent,
  type ReviewAgentDeps,
  type ReviewLens,
} from "./agent-runtime.js";
export {
  ARCHITECTURE_SYSTEM_PROMPT,
  CORRECTNESS_SYSTEM_PROMPT,
  SECURITY_SYSTEM_PROMPT,
  architectureLens,
  correctnessLens,
  createArchitectureAgent,
  createCorrectnessAgent,
  createReviewAgents,
  createSecurityAgent,
  securityLens,
} from "./agents.js";
