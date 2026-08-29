/**
 * Publishing the in-code system prompts to Langfuse.
 *
 * Managed prompts only pay for themselves once Langfuse actually holds
 * them: until then every review silently runs on its in-code fallback,
 * which looks identical in the output and completely different in the
 * logs. This module is the one place that writes, so a Langfuse project
 * can be brought up to the current build's prompts in one command.
 *
 * Deliberately separate from prompts.ts rather than folded into it.
 * LangfusePromptClient is a read-only seam and the action's runtime
 * path depends on that: a review has no business creating prompt
 * versions, and nothing on the review path can reach a writer it never
 * imports.
 *
 * The repository is the source of truth for the BASELINE, not for
 * every version. A prompt edited in the Langfuse UI keeps serving
 * reviews — that is the entire point of managing prompts there — and
 * is superseded only when someone runs the seeder again, which leaves
 * the edited version intact in Langfuse's history.
 */
import {
  createConsoleLogger,
  errorMessage,
  type StructuredLogger,
} from "@pr-review/logging";

import {
  DEFAULT_PROMPT_LABEL,
  MANAGED_PROMPT_IDS,
  MANAGED_PROMPT_KEYS,
  createLangfuseClient,
  fetchTextPrompt,
  promptContractProblems,
  type LangfusePromptClientConfig,
  type ManagedPromptId,
  type ManagedPrompts,
} from "./prompts.js";

/** One prompt version as it currently stands at a label. */
export interface LabelledPrompt {
  text: string;
  version: number;
}

/**
 * Injectable seam over prompt WRITING, mirroring how
 * LangfusePromptClient wraps prompt reading. Production wraps
 * LangfuseClient; tests inject a stub, so the decision logic below is
 * exercised without a Langfuse project.
 *
 * `readLabelled` resolves to undefined for a prompt that does not
 * exist yet — "absent" is an ordinary outcome here (it is what a fresh
 * project looks like), not an error worth a stack trace.
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
      // A Langfuse deployment label points at exactly one version, so
      // creating a version that carries the label also moves it off
      // whichever version held it before. No separate update call.
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

/**
 * Whether a rejected fetch means "no such prompt" rather than a real
 * failure. Checked structurally: the SDK's error classes are not part
 * of its public surface, but the HTTP status is stable.
 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode: unknown }).statusCode === 404
  );
}

/**
 * What one seed run did to one prompt.
 *
 * `rejected` is the interesting one: the prompt failed the same
 * contract guard loadManagedPrompts applies to fetched text, so
 * publishing it would install a version that every review refuses and
 * falls back from — a silent no-op dressed up as a successful seed.
 */
export type SeedOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "rejected"
  | "failed";

export interface SeedManagedPromptsOptions {
  /** The prompts to publish, normally from inCodePrompts(). */
  prompts: ManagedPrompts;
  /** Deployment label to point at the published versions. */
  label?: string | undefined;
  /** Decide everything, write nothing. */
  dryRun?: boolean | undefined;
  logger?: StructuredLogger | undefined;
}

export type SeedReport = Record<ManagedPromptId, SeedOutcome>;

/**
 * Publishes each managed prompt that Langfuse does not already hold at
 * this label.
 *
 * Idempotent by comparison, not by luck: an unchanged prompt costs one
 * read and no version. That matters because Langfuse versions are
 * permanent — a seeder that pushed unconditionally would bury the real
 * prompt history under identical re-runs.
 *
 * Never rejects. One prompt failing leaves the other three publishable,
 * the same isolation loadManagedPrompts gives each fetch, so a partial
 * outcome is reported rather than hidden behind whichever prompt
 * happened to fail first.
 */
export async function seedManagedPrompts(
  writer: LangfusePromptWriter,
  options: SeedManagedPromptsOptions,
): Promise<SeedReport> {
  const logger = options.logger ?? createConsoleLogger();
  const label = options.label ?? DEFAULT_PROMPT_LABEL;
  const dryRun = options.dryRun ?? false;

  const outcomes = await Promise.all(
    MANAGED_PROMPT_IDS.map(async (id): Promise<SeedOutcome> => {
      const name = MANAGED_PROMPT_KEYS[id];
      const text = options.prompts[id];

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
    MANAGED_PROMPT_IDS.map((id, index) => [id, outcomes[index]]),
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
