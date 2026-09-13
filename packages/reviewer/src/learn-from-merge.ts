/**
 * What a merged pull request taught us: every thread our review opened, and
 * whether the repository resolved it, outran it, or left it alone.
 */
import type { GithubInstallationClient, ReviewThread } from "@pr-review/github";
import { errorMessage, type StructuredLogger } from "@pr-review/logging";

import {
  readMemory,
  recordSignals,
  writeMemory,
  type FindingOutcome,
  type FindingSignal,
  type MemoryStore,
} from "./memory.js";
import { parsePostedFinding } from "./render-review.js";
import { reviewCorrelation, type ReviewTarget } from "./review-target.js";

export interface LearnFromMergeDeps {
  client: Pick<GithubInstallationClient, "listReviewThreads">;
  store: MemoryStore;
  logger: StructuredLogger;
  /** Injectable clock, so a test can pin the recorded signal time. */
  now?: Date | undefined;
}

/** Resolved beats outdated: someone acted before the code moved on. */
function outcomeOf(thread: ReviewThread): FindingOutcome {
  if (thread.isResolved) {
    return "resolved";
  }
  return thread.isOutdated ? "outdated" : "ignored";
}

function countOf(
  signals: readonly FindingSignal[],
  outcome: FindingOutcome,
): number {
  return signals.filter((signal) => signal.outcome === outcome).length;
}

/**
 * Never throws: a merge must not fail because the memory branch is
 * unwritable or the threads cannot be read.
 */
export async function learnFromMergedPullRequest(
  target: ReviewTarget,
  deps: LearnFromMergeDeps,
): Promise<{ signals: number }> {
  const { client, store, logger } = deps;
  const now = deps.now ?? new Date();
  const fields = reviewCorrelation(target);

  try {
    const signals: FindingSignal[] = [];
    for (const thread of await client.listReviewThreads(target)) {
      const finding = parsePostedFinding(thread.body);
      if (finding === undefined) {
        continue;
      }
      signals.push({
        category: finding.category,
        title: finding.title,
        outcome: outcomeOf(thread),
      });
    }

    if (signals.length === 0) {
      logger.info("memory.no_signals", fields);
      return { signals: 0 };
    }

    const memory = await readMemory(store, logger);
    await writeMemory(store, recordSignals(memory, signals, now));
    logger.info("memory.updated", {
      ...fields,
      signals: signals.length,
      resolved: countOf(signals, "resolved"),
      outdated: countOf(signals, "outdated"),
      ignored: countOf(signals, "ignored"),
    });
    return { signals: signals.length };
  } catch (error: unknown) {
    logger.error("memory.update_failed", {
      ...fields,
      error: errorMessage(error),
    });
    return { signals: 0 };
  }
}
