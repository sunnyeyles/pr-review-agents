/**
 * The review pipeline: agents run concurrently, then join -> synthesise ->
 * validate in sequence.
 */
import {
  emptyTokenUsage,
  type ReviewAgent,
  type ReviewContext,
  type Synthesiser,
  type TokenUsage,
} from "@pr-review/ai";
import { errorMessage, errorName } from "@pr-review/logging";
import type { ReviewFinding } from "@pr-review/schemas";

import { validateFindings } from "./validate-findings.js";

/** One agent that did not produce candidates, and why. */
export interface AgentFailure {
  agent: string;
  error: string;
}

/** One agent's outcome. */
interface AgentOutcome {
  name: string;
  candidates?: unknown[];
  error?: string;
}

/** What `join` derives from the agent outcomes. */
interface JoinedCandidates {
  /** Untrusted candidate findings, in agent order. */
  candidates: unknown[];
  /** Agents that failed while at least one other agent succeeded. */
  agentFailures: AgentFailure[];
}

/** The synthesise step's outcome; the tag decides which fields exist. */
export type SynthesisState =
  | { outcome: "skipped"; candidates: unknown[]; usage: TokenUsage }
  | {
      outcome: "completed";
      candidates: unknown[];
      usage: TokenUsage;
      durationMs: number;
    }
  | {
      outcome: "failed";
      candidates: unknown[];
      usage: TokenUsage;
      error: string;
      errorName: string;
      durationMs: number;
    };

/** The outcome of a synthesise step that never ran. */
export function skippedSynthesis(): SynthesisState {
  return { outcome: "skipped", candidates: [], usage: emptyTokenUsage() };
}

/** Runs one agent, recording success or failure; never throws. */
async function runAgent(
  agent: ReviewAgent,
  context: ReviewContext,
): Promise<AgentOutcome> {
  try {
    const candidates = await agent.run(context);
    return { name: agent.name, candidates: [...candidates] };
  } catch (error) {
    return { name: agent.name, error: errorMessage(error) };
  }
}

/**
 * Fan-in: derives candidates/failures in the agents' original order —
 * never completion order — and throws when every agent failed.
 */
function join(outcomes: readonly AgentOutcome[]): JoinedCandidates {
  const candidates: unknown[] = [];
  const agentFailures: AgentFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      agentFailures.push({ agent: outcome.name, error: outcome.error });
    } else {
      candidates.push(...(outcome.candidates ?? []));
    }
  }

  if (agentFailures.length === outcomes.length) {
    const details = agentFailures
      .map((failure) => `${failure.agent}: ${failure.error}`)
      .join("; ");
    throw new Error(`every review agent failed — ${details}`);
  }

  return { candidates, agentFailures };
}

/**
 * "skipped" means the Synthesiser was never invoked. A failure falls
 * back to the raw candidates rather than failing the review.
 */
async function synthesise(
  synthesiser: Synthesiser,
  candidates: unknown[],
): Promise<SynthesisState> {
  if (candidates.length === 0) {
    return skippedSynthesis();
  }

  const startedAt = Date.now();
  try {
    const result = await synthesiser.synthesise(candidates);
    return {
      outcome: "completed",
      candidates: result.findings,
      usage: result.usage,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      outcome: "failed",
      candidates,
      usage: emptyTokenUsage(),
      error: errorMessage(error),
      errorName: errorName(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** The full outcome of one review-pipeline run, for the caller to log and publish. */
export interface ReviewPipelineResult {
  /** Untrusted candidate findings from every successful agent, in agent order. */
  candidates: unknown[];
  /** Agents that failed while at least one other agent succeeded. */
  agentFailures: AgentFailure[];
  /** The synthesise step's own outcome; every field it carries is one the tag guarantees. */
  synthesis: SynthesisState;
  /** The final, deterministically validated findings. */
  findings: ReviewFinding[];
}

/** Throws when every agent failed; a synthesis failure never throws. */
export async function runReviewPipeline(
  agents: readonly ReviewAgent[],
  synthesiser: Synthesiser,
  context: ReviewContext,
): Promise<ReviewPipelineResult> {
  if (agents.length === 0) {
    throw new Error("runReviewPipeline requires at least one review agent");
  }

  const outcomes = await Promise.all(
    agents.map((agent) => runAgent(agent, context)),
  );
  const { candidates, agentFailures } = join(outcomes);
  const synthesis = await synthesise(synthesiser, candidates);

  return {
    candidates,
    agentFailures,
    synthesis,
    findings: validateFindings(
      synthesis.candidates,
      context.changedFiles,
      agents.map((agent) => agent.name),
    ),
  };
}
