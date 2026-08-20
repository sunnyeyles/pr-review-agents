/**
 * Managed system prompts: registry keys, an injectable retrieval seam,
 * and a one-shot load with per-prompt local fallback.
 *
 * The four system prompts this system runs on are editable in Langfuse
 * so a prompt change does not need a release. They are fetched once per
 * process and used for its lifetime. Every failure mode — the service
 * being down, a missing prompt, empty content, a slow response, or text
 * that no longer honours the output contract — falls back to the
 * in-code prompt for that one entry, so a review always runs.
 *
 * Fetching is opt-in: without Langfuse credentials the caller never
 * builds a client and every prompt is the in-code one.
 */
import { LangfuseClient } from "@langfuse/client";
import { createConsoleLogger, type StructuredLogger } from "@pr-review/logging";
import type { FindingCategory } from "@pr-review/schemas";

import { buildReviewSystemPrompt } from "./agent-runtime.js";
import { reviewLenses } from "./agents.js";

/** Stable Langfuse prompt names for the four managed system prompts. */
export const MANAGED_PROMPT_KEYS = {
  correctness: "correctness_system",
  security: "security_system",
  architecture: "architecture_system",
  synthesis: "synthesis_system",
} as const;

export type ManagedPromptId = keyof typeof MANAGED_PROMPT_KEYS;

/** Where a resolved prompt came from. */
export type PromptSource = "langfuse" | "fallback";

/** Resolved system prompts, ready to inject into agents / synthesiser. */
export interface ManagedPrompts {
  correctness: string;
  security: string;
  architecture: string;
  synthesis: string;
}

export interface LoadPromptsResult {
  prompts: ManagedPrompts;
  sources: Record<ManagedPromptId, PromptSource>;
}

/** Label fetched when the caller does not name one. */
export const DEFAULT_PROMPT_LABEL = "production";

/** How long one prompt fetch may take before it is abandoned. */
export const DEFAULT_PROMPT_TIMEOUT_MS = 5_000;

/**
 * Injectable seam over prompt retrieval. Production wraps
 * LangfuseClient; tests inject a stub so no network calls happen.
 *
 * Deliberately narrower than the SDK: no prompt objects, no variable
 * compilation, no cache handles — a name goes in and resolved text
 * comes out. Empty content is an error here, not a valid result, so
 * callers need no separate emptiness check.
 */
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
  /** Per-request timeout. Defaults to DEFAULT_PROMPT_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
}

/** Builds a LangfusePromptClient over the official SDK. */
export function createLangfusePromptClient(
  config: LangfusePromptClientConfig,
): LangfusePromptClient {
  const client = new LangfuseClient({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });
  const timeoutMs = config.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

  return {
    async getTextPrompt(name, options) {
      const prompt = await client.prompt.get(name, {
        type: "text",
        label: options?.label ?? DEFAULT_PROMPT_LABEL,
        // The one-shot load below caches for the process lifetime;
        // a second in-SDK cache would only add a stale TTL.
        cacheTtlSeconds: 0,
        // Bounds the socket. loadManagedPrompts also bounds the call,
        // but only this reaches the request itself.
        fetchTimeoutMs: timeoutMs,
      });
      const text = prompt.prompt.trim();
      if (text.length === 0) {
        throw new Error(`Langfuse prompt "${name}" is empty`);
      }
      return text;
    },
  };
}

/**
 * The invariants a fetched prompt must satisfy before it is trusted.
 *
 * A remotely-edited prompt is repository content by another name, and a
 * prompt that has lost its output contract fails SILENTLY: the runtime
 * discards findings whose category is not the lens's own, so a lens
 * prompt missing its category reports "no findings" on every review
 * rather than erroring. Cheap structural checks catch that before it
 * reaches a model, and they mirror the assertions the in-code prompts
 * are already held to in the tests.
 */
function promptContractProblems(id: ManagedPromptId, text: string): string[] {
  const problems: string[] = [];

  if (!/data.*not instructions|never instructions/is.test(text)) {
    problems.push("missing-injection-hardening");
  }
  if (!/\bJSON\b/i.test(text)) {
    problems.push("missing-json-contract");
  }
  if (id !== "synthesis" && !text.includes(`"${id}"`)) {
    // The lens category is quoted into the findings contract; without
    // it every finding this lens proposes is discarded downstream.
    problems.push("missing-category-contract");
  }

  return problems;
}

export interface LoadManagedPromptsOptions {
  /** Label to fetch. Defaults to DEFAULT_PROMPT_LABEL. */
  label?: string | undefined;
  logger?: StructuredLogger | undefined;
  /** Per-prompt deadline. Defaults to DEFAULT_PROMPT_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
  /**
   * Fallback for the synthesiser's system prompt. It lives in
   * @pr-review/reviewer, which depends on this package, so the caller
   * injects it rather than this package importing it.
   */
  synthesisFallback: string;
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

/** The in-code prompt for every lens, keyed by category. */
function lensFallbacks(): Record<FindingCategory, string> {
  return Object.fromEntries(
    reviewLenses.map((lens) => [lens.category, buildReviewSystemPrompt(lens)]),
  ) as Record<FindingCategory, string>;
}

/**
 * Fetches all four managed system prompts.
 *
 * Never rejects and never returns a partial result: each prompt falls
 * back independently, so one broken entry costs one prompt rather than
 * the whole review.
 */
export async function loadManagedPrompts(
  client: LangfusePromptClient,
  options: LoadManagedPromptsOptions,
): Promise<LoadPromptsResult> {
  const logger = options.logger ?? createConsoleLogger();
  const label = options.label ?? DEFAULT_PROMPT_LABEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

  const lens = lensFallbacks();
  const fallbacks: ManagedPrompts = {
    correctness: lens.correctness,
    security: lens.security,
    architecture: lens.architecture,
    synthesis: options.synthesisFallback,
  };

  // Start from the fallbacks so nothing can be left undefined and a
  // fetch is only ever an upgrade.
  const prompts: ManagedPrompts = { ...fallbacks };
  const sources: Record<ManagedPromptId, PromptSource> = {
    correctness: "fallback",
    security: "fallback",
    architecture: "fallback",
    synthesis: "fallback",
  };

  const ids = Object.keys(MANAGED_PROMPT_KEYS) as ManagedPromptId[];
  await Promise.all(
    ids.map(async (id) => {
      const name = MANAGED_PROMPT_KEYS[id];
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
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  const loaded = ids.filter((id) => sources[id] === "langfuse");
  const fellBack = ids.filter((id) => sources[id] === "fallback");
  logger.info("langfuse.prompts.loaded", {
    label,
    loadedPromptKeys: loaded.map((id) => MANAGED_PROMPT_KEYS[id]),
    fallbackPromptKeys: fellBack.map((id) => MANAGED_PROMPT_KEYS[id]),
    loadedCount: loaded.length,
    fallbackCount: fellBack.length,
  });

  return { prompts, sources };
}
