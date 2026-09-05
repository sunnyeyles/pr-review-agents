/**
 * Managed system prompts, fetched once per process from Langfuse. Any
 * failure falls back to the in-code prompt for that one entry.
 */
import { LangfuseClient } from "@langfuse/client";
import type { FindingCategory } from "@pr-review/schemas";
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import {
  SYNTHESIS_PROMPT_ID,
  buildReviewSystemPrompt,
  agentPromptKey,
  type AgentDefinition,
} from "./agents/definition.js";
import { buildSynthesisSystemPrompt } from "./agents/synthesiser.js";

/** Where a resolved prompt came from. */
type PromptSource = "langfuse" | "fallback";

/**
 * System prompts keyed by managed-prompt id. inCodePrompts decides the set,
 * and its keys are the only place the ids are enumerated.
 */
export type ManagedPrompts = Record<string, string>;

interface LoadPromptsResult {
  prompts: ManagedPrompts;
  sources: Record<string, PromptSource>;
}

/** Label fetched when the caller does not name one. */
export const DEFAULT_PROMPT_LABEL = "production";

/** Langfuse host used when the caller does not name one. */
export const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";

/** How long one prompt fetch may take before it is abandoned. */
const DEFAULT_PROMPT_TIMEOUT_MS = 5_000;

/** Injectable seam over prompt retrieval. Empty content is an error, not a result. */
export interface LangfusePromptClient {
  getTextPrompt(
    name: string,
    options?: { label?: string | undefined },
  ): Promise<string>;
}

export interface LangfusePromptClientConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/** The SDK client shared by the prompt reader here and the writer in seed-prompts.ts. */
export function createLangfuseClient(
  config: LangfusePromptClientConfig,
): LangfuseClient {
  return new LangfuseClient({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });
}

/**
 * One uncached prompt fetch at a label. `cacheTtlSeconds: 0` matters: the
 * loader caches for the process lifetime, and the seeder needs live data.
 */
export function fetchTextPrompt(
  client: LangfuseClient,
  name: string,
  label: string,
) {
  return client.prompt.get(name, {
    type: "text",
    label,
    cacheTtlSeconds: 0,
    fetchTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
  });
}

/** Builds a LangfusePromptClient over the official SDK. */
export function createLangfusePromptClient(
  config: LangfusePromptClientConfig,
): LangfusePromptClient {
  const client = createLangfuseClient(config);
  return {
    async getTextPrompt(name, options) {
      const prompt = await fetchTextPrompt(
        client,
        name,
        options?.label ?? DEFAULT_PROMPT_LABEL,
      );
      const text = prompt.prompt.trim();
      if (text.length === 0) {
        throw new Error(`Langfuse prompt "${name}" is empty`);
      }
      return text;
    },
  };
}

/** The invariants every system prompt must satisfy, wherever it came from. */
function sharedPromptProblems(text: string): string[] {
  const problems: string[] = [];

  if (!/data.*not instructions|never instructions/is.test(text)) {
    problems.push("missing-injection-hardening");
  }
  if (!/\bJSON\b/i.test(text)) {
    problems.push("missing-json-contract");
  }

  return problems;
}

/**
 * The invariants a review-agent system prompt must satisfy. Losing the output
 * contract fails silently: the runtime discards off-category findings.
 */
export function reviewPromptContractProblems(
  text: string,
  category: FindingCategory,
): string[] {
  const problems = sharedPromptProblems(text);

  if (!/comments?.*(never|not).*instructions/is.test(text)) {
    problems.push("missing-comment-hardening");
  }
  if (
    !/tool (results?|output).*(no|cannot|never).*(permission|privilege)/is.test(
      text,
    )
  ) {
    problems.push("missing-tool-result-hardening");
  }
  if (!/final JSON/i.test(text)) {
    problems.push("missing-final-json-contract");
  }
  if (!text.includes(`"${category}"`)) {
    problems.push("missing-category-contract");
  }

  return problems;
}

/** The contract for one managed prompt; gates both fetched and about-to-be-seeded text. */
export function promptContractProblems(id: string, text: string): string[] {
  // The synthesiser reads findings rather than a repository, so none of
  // the agent-specific rules apply.
  return id === SYNTHESIS_PROMPT_ID
    ? sharedPromptProblems(text)
    : reviewPromptContractProblems(text, id);
}

/**
 * The prompts one agent set implies: both the loader's fallback and the
 * seeder's baseline, so the two cannot disagree.
 */
export function inCodePrompts(agents: readonly AgentDefinition[]): ManagedPrompts {
  const prompts: ManagedPrompts = {};
  for (const agent of agents) {
    prompts[agent.category] = buildReviewSystemPrompt(agent);
  }
  prompts[SYNTHESIS_PROMPT_ID] = buildSynthesisSystemPrompt(agents);
  return prompts;
}

interface LoadManagedPromptsOptions {
  /** The run's agent set; decides which prompts are fetched. */
  agents: readonly AgentDefinition[];
  /** Label to fetch. Defaults to DEFAULT_PROMPT_LABEL. */
  label?: string | undefined;
  logger?: StructuredLogger | undefined;
  /** Per-prompt deadline. Defaults to DEFAULT_PROMPT_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
}

/** Rejects once `ms` has passed, so one slow fetch cannot stall the run. */
function withDeadline<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Langfuse prompt "${name}" timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Never rejects: each prompt falls back independently. */
export async function loadManagedPrompts(
  client: LangfusePromptClient,
  options: LoadManagedPromptsOptions,
): Promise<LoadPromptsResult> {
  const logger = options.logger ?? createConsoleLogger();
  const label = options.label ?? DEFAULT_PROMPT_LABEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

  // Start from the in-code prompts so a fetch is only ever an upgrade.
  const prompts: ManagedPrompts = inCodePrompts(options.agents);
  const ids = Object.keys(prompts);
  const sources: Record<string, PromptSource> = Object.fromEntries(
    ids.map((id) => [id, "fallback" as PromptSource]),
  );

  await Promise.all(
    ids.map(async (id) => {
      const name = agentPromptKey(id);
      try {
        const text = await withDeadline(
          client.getTextPrompt(name, { label }),
          timeoutMs,
          name,
        );
        const problems = promptContractProblems(id, text);
        if (problems.length > 0) {
          logger.error("langfuse.prompts.fallback_used", {
            promptKey: name,
            reason: `rejected by the prompt contract guard: ${problems.join(", ")}`,
          });
          return;
        }
        prompts[id] = text;
        sources[id] = "langfuse";
      } catch (error) {
        logger.error("langfuse.prompts.fallback_used", {
          promptKey: name,
          reason: errorMessage(error),
        });
      }
    }),
  );

  const loaded = ids.filter((id) => sources[id] === "langfuse");
  const fellBack = ids.filter((id) => sources[id] === "fallback");
  logger.info("langfuse.prompts.loaded", {
    label,
    loadedPromptKeys: loaded.map(agentPromptKey),
    fallbackPromptKeys: fellBack.map(agentPromptKey),
    loadedCount: loaded.length,
    fallbackCount: fellBack.length,
  });

  return { prompts, sources };
}
