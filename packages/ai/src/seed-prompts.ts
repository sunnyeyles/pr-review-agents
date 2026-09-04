/**
 * Publishes the in-code system prompts to Langfuse. Kept separate from
 * prompts.ts so nothing on the review path can reach a writer.
 * The repository is the source of truth for the baseline, not every version.
 */
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import { agentPromptKey } from "./agents/definition.js";
import {
  DEFAULT_PROMPT_LABEL,
  createLangfuseClient,
  fetchTextPrompt,
  promptContractProblems,
  type LangfusePromptClientConfig,
  type ManagedPrompts,
} from "./prompts.js";

/** One prompt version as it currently stands at a label. */
export interface LabelledPrompt {
  text: string;
  version: number;
}

/**
 * Injectable seam over prompt writing. `readLabelled` resolves to
 * undefined for a prompt that does not exist yet, which is not an error.
 */
export interface LangfusePromptWriter {
  readLabelled(
    name: string,
    label: string,
  ): Promise<LabelledPrompt | undefined>;
  publish(input: {
    name: string;
    text: string;
    label: string;
    commitMessage: string;
  }): Promise<LabelledPrompt>;
}

/** Builds a LangfusePromptWriter over the official SDK. */
export function createLangfusePromptWriter(
  config: LangfusePromptClientConfig,
): LangfusePromptWriter {
  const client = createLangfuseClient(config);

  return {
    async readLabelled(name, label) {
      try {
        const prompt = await fetchTextPrompt(client, name, label);
        return { text: prompt.prompt, version: prompt.version };
      } catch (error: unknown) {
        if (isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },
    async publish({ name, text, label, commitMessage }) {
      // A label points at exactly one version, so creating a version
      // with the label also moves it off the previous holder.
      const created = await client.prompt.create({
        name,
        prompt: text,
        type: "text",
        labels: [label],
        commitMessage,
      });
      return { text: created.prompt, version: created.version };
    },
  };
}

/** Checked structurally: the SDK's error classes are not public, but the status is. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode: unknown }).statusCode === 404
  );
}

/** What one seed run did to one prompt. `rejected` means it failed the contract guard. */
export type SeedOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "rejected"
  | "failed";

export interface SeedManagedPromptsOptions {
  /** The prompts to publish, from inCodePrompts(agents); its keys decide what is seeded. */
  prompts: ManagedPrompts;
  /** Deployment label to point at the published versions. */
  label?: string | undefined;
  /** Decide everything, write nothing. */
  dryRun?: boolean | undefined;
  logger?: StructuredLogger | undefined;
}

export type SeedReport = Record<string, SeedOutcome>;

/**
 * Publishes each managed prompt Langfuse does not already hold at this
 * label. Unchanged prompts create no version — Langfuse versions are
 * permanent. Never rejects; each prompt succeeds or fails alone.
 */
export async function seedManagedPrompts(
  writer: LangfusePromptWriter,
  options: SeedManagedPromptsOptions,
): Promise<SeedReport> {
  const logger = options.logger ?? createConsoleLogger();
  const label = options.label ?? DEFAULT_PROMPT_LABEL;
  const dryRun = options.dryRun ?? false;

  const entries = Object.entries(options.prompts);
  const outcomes = await Promise.all(
    entries.map(async ([id, text]): Promise<SeedOutcome> => {
      const name = agentPromptKey(id);

      const problems = promptContractProblems(id, text);
      if (problems.length > 0) {
        logger.error("langfuse.prompts.seed_rejected", {
          promptKey: name,
          label,
          reason: `rejected by the prompt contract guard: ${problems.join(", ")}`,
        });
        return "rejected";
      }

      try {
        const existing = await writer.readLabelled(name, label);
        if (existing !== undefined && existing.text.trim() === text.trim()) {
          logger.info("langfuse.prompts.seed_unchanged", {
            promptKey: name,
            label,
            version: existing.version,
          });
          return "unchanged";
        }

        const outcome: SeedOutcome =
          existing === undefined ? "created" : "updated";
        if (dryRun) {
          logger.info("langfuse.prompts.seed_planned", {
            promptKey: name,
            label,
            plannedOutcome: outcome,
            ...(existing === undefined ? {} : { currentVersion: existing.version }),
          });
          return outcome;
        }

        const published = await writer.publish({
          name,
          text,
          label,
          commitMessage:
            existing === undefined
              ? "Seeded from the in-code prompt"
              : "Re-seeded from the in-code prompt",
        });
        logger.info("langfuse.prompts.seeded", {
          promptKey: name,
          label,
          outcome,
          version: published.version,
        });
        return outcome;
      } catch (error: unknown) {
        logger.error("langfuse.prompts.seed_failed", {
          promptKey: name,
          label,
          error: errorMessage(error),
        });
        return "failed";
      }
    }),
  );

  const report = Object.fromEntries(
    entries.map(([id], index) => [id, outcomes[index]]),
  ) as SeedReport;

  logger.info("langfuse.prompts.seed_completed", {
    label,
    dryRun,
    ...countByOutcome(report),
  });

  return report;
}

/** Per-outcome totals for the summary log line. */
function countByOutcome(report: SeedReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of Object.values(report)) {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

/** Whether a report contains anything that should fail the command. */
export function seedFailed(report: SeedReport): boolean {
  return Object.values(report).some(
    (outcome) => outcome === "failed" || outcome === "rejected",
  );
}
