/**
 * The review orchestrator (spec §8, §20): runs the review agents
 * against one loaded PR context and returns their combined CANDIDATE
 * findings for the deterministic validation chain.
 *
 * All agents run CONCURRENTLY over the same context: Promise.allSettled
 * over runs that all start before any is awaited.
 *
 * Partial-failure semantics (spec §20): one failed agent does not fail
 * the review while any other agent succeeded — its failure is recorded
 * and the surviving candidates are returned. When EVERY agent fails,
 * the review itself fails so the job is retried and eventually
 * dead-lettered by SQS.
 */
import type { ReviewAgent, ReviewContext } from "@pr-review/ai";

/** One agent that did not produce candidates, and why. */
export interface AgentFailure {
  agent: string;
  error: string;
}

export interface ReviewRunResult {
  /** Untrusted candidate findings, in agent order, for validateFindings. */
  candidates: unknown[];
  /** Agents that failed while at least one other agent succeeded. */
  agentFailures: AgentFailure[];
}

/**
 * Runs every agent against the context (concurrently) and combines
 * their candidate findings. Throws when no agent produced a result.
 */
export async function runReview(
  agents: readonly ReviewAgent[],
  context: ReviewContext,
): Promise<ReviewRunResult> {
  if (agents.length === 0) {
    throw new Error("runReview requires at least one review agent");
  }

  const settled = await Promise.allSettled(
    agents.map((agent) => agent.run(context)),
  );

  const candidates: unknown[] = [];
  const agentFailures: AgentFailure[] = [];
  for (const [index, agent] of agents.entries()) {
    const outcome = settled[index];
    if (outcome === undefined) {
      continue; // unreachable: settled has one entry per agent
    }
    if (outcome.status === "fulfilled") {
      candidates.push(...outcome.value);
    } else {
      agentFailures.push({
        agent: agent.name,
        error:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
      });
    }
  }

  if (agentFailures.length === agents.length) {
    const details = agentFailures
      .map((failure) => `${failure.agent}: ${failure.error}`)
      .join("; ");
    throw new Error(`every review agent failed — ${details}`);
  }

  return { candidates, agentFailures };
}
