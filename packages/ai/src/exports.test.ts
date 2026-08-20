/**
 * Barrel guard for @pr-review/ai.
 *
 * The package entry point is a published contract: every consumer
 * imports through it, so a symbol dropped from it during a refactor
 * breaks callers. Runtime keys catch value exports; the type tuple
 * below hands the same job for types to `tsc --noEmit`, which is the
 * only thing that can see them.
 *
 * Adding an export means adding it here — deliberately, in the same
 * change that widens the surface.
 */
import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import type {
  AgentOutputResult,
  AgentRunError,
  AnthropicClientConfig,
  AnthropicLike,
  GenerationParent,
  LangfusePromptClient,
  LangfusePromptClientConfig,
  LoadManagedPromptsOptions,
  LoadPromptsResult,
  ManagedPromptId,
  ManagedPrompts,
  ModelCallTrace,
  PromptSource,
  ReviewAgent,
  ReviewAgentDeps,
  ReviewContext,
  ReviewLens,
  ReviewSystemPrompts,
  TokenUsage,
} from "./index.js";

/** Every value export of the package, sorted. */
const DOCUMENTED_EXPORTS = [
  "AgentRunError",
  "DEFAULT_LANGFUSE_BASE_URL",
  "DEFAULT_PROMPT_LABEL",
  "MANAGED_PROMPT_KEYS",
  "addTokenUsage",
  "architectureLens",
  "correctnessLens",
  "createAnthropicClient",
  "createLangfusePromptClient",
  "createReviewAgent",
  "createReviewAgents",
  "emptyTokenUsage",
  "extractAgentOutput",
  "loadManagedPrompts",
  "reviewLenses",
  "reviewPromptContractProblems",
  "securityLens",
  "traceModelCall",
] as const;

/** Every type export of the package. */
type DocumentedTypes = [
  AgentOutputResult,
  AgentRunError,
  AnthropicClientConfig,
  AnthropicLike,
  LangfusePromptClient,
  LangfusePromptClientConfig,
  LoadManagedPromptsOptions,
  LoadPromptsResult,
  ManagedPromptId,
  ManagedPrompts,
  PromptSource,
  ReviewAgent,
  ReviewAgentDeps,
  ReviewContext,
  ReviewLens,
  ReviewSystemPrompts,
  TokenUsage,
];

describe("@pr-review/ai public entry point", () => {
  it("exports exactly its documented symbol set", () => {
    expect(Object.keys(barrel).sort()).toEqual([...DOCUMENTED_EXPORTS]);
  });

  it("exports every documented type (enforced by typecheck)", () => {
    const documented: DocumentedTypes[] = [];
    expect(documented).toHaveLength(0);
  });
});
