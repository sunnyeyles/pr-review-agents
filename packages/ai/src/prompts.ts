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
import type { FindingCategory } from "@pr-review/schemas";
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import { buildReviewSystemPrompt } from "./agent-runtime.js";
import {
  architectureLens,
  correctnessLens,
  securityLens,
} from "./agents.js";

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

/** Langfuse host used when the caller does not name one. */
export const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";

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
        fetchTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
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
 * The invariants EVERY system prompt must satisfy, wherever it came
 * from. Repository content reaches all of them, so all of them must
 * say that such content is data rather than instructions, and all of
 * them must end in a JSON contract.
 */
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
 * The invariants a review-lens system prompt must satisfy — the single
 * definition, asserted against the in-code prompts by agents.test.ts
 * and against fetched ones by loadManagedPrompts.
 *
 * A remotely-edited prompt is repository content by another name, and
 * one that has lost its output contract fails SILENTLY: the runtime
 * discards findings whose category is not the lens's own, so a prompt
 * missing its category reports "no findings" on every review rather
 * than erroring. These structural checks catch that before it reaches
 * a model. Keeping one definition is what stops the gate on remote
 * prompts drifting weaker than the bar the shipped prompts meet.
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
    // The lens category is quoted into the findings contract; without
    // it every finding this lens proposes is discarded downstream.
    problems.push("missing-category-contract");
  }

  return problems;
}

/**
 * The contract for one managed prompt, by which prompt it is.
 *
 * Exported because the same gate has to run in both directions: on a
 * prompt fetched from Langfuse before a review trusts it, and on a
 * prompt about to be published to Langfuse. Seeding text that this
 * would reject would install a prompt guaranteed to fall back.
 */
export function promptContractProblems(
  id: ManagedPromptId,
  text: string,
): string[] {
  // The synthesiser reads findings rather than a repository, so it
  // carries the shared hardening but none of the lens-specific rules.
  return id === "synthesis"
    ? sharedPromptProblems(text)
    : reviewPromptContractProblems(text, id);
}

/**
 * The four prompts exactly as this build defines them, before Langfuse
 * is consulted at all.
 *
 * Two callers need them and must never disagree: loadManagedPrompts
 * uses them as the fallback every fetch is only ever an upgrade on,
 * and the seeder publishes them as the baseline version. Building them
 * here once is what keeps "what a review falls back to" and "what gets
 * pushed to Langfuse" the same text.
 *
 * The synthesis prompt is injected for the same reason it is on
 * LoadManagedPromptsOptions: it lives in @pr-review/reviewer, which
 * depends on this package.
 */
export function inCodePrompts(synthesisFallback: string): ManagedPrompts {
  return {
    correctness: buildReviewSystemPrompt(correctnessLens),
    security: buildReviewSystemPrompt(securityLens),
    architecture: buildReviewSystemPrompt(architectureLens),
    synthesis: synthesisFallback,
  };
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

  // Start from the in-code prompts so nothing can be left undefined
  // and a fetch is only ever an upgrade.
  const prompts: ManagedPrompts = inCodePrompts(options.synthesisFallback);
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
          reason: errorMessage(error),
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
