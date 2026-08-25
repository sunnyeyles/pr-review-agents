/**
 * The review pipeline as one LangGraph StateGraph:
 *
 *   START --> agent__correctness --\
 *         \-> agent__security     --> join --> synthesise --> validate --> END
 *          \-> agent__architecture-/
 *
 * The agent nodes run concurrently; the three after them run in
 * sequence once every agent has settled. Three rules shape the flow:
 *
 * - Partial failure survives. `join` throws only when EVERY agent
 *   failed, and re-sorts outcomes by input position so the result never
 *   depends on which agent settled first.
 * - Synthesis is optional. Zero candidates skips the model call; a
 *   failure falls back to the RAW candidates. The caller reads
 *   `synthesisOutcome` / `synthesisError` to log which happened.
 * - `validate` is the ONLY node whose output the caller may trust.
 */
import { emptyTokenUsage, type ReviewAgent, type ReviewContext, type TokenUsage } from "@pr-review/ai";
import { errorMessage, errorName } from "@pr-review/logging";
import type { ReviewFinding } from "@pr-review/schemas";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import type { Synthesiser } from "./synthesiser.js";
import { validateFindings } from "./validate-findings.js";

/** One agent that did not produce candidates, and why. */
export interface AgentFailure {
  agent: string;
  error: string;
}

/** One agent node's outcome, tagged with its position in the input list. */
interface AgentOutcome {
  index: number;
  name: string;
  candidates?: unknown[];
  error?: string;
}

/**
 * A channel exactly one node writes: the last write wins, which is what
 * a plain variable already does. Most channels are this, so spelling
 * the reducer out at each one only buried the ONE channel below whose
 * reducer carries real meaning.
 *
 * A channel with no default is set at invoke and must be.
 */
function lastWins<T>(defaultValue?: () => T) {
  const reducer = (_left: T, right: T): T => right;
  return defaultValue === undefined
    ? Annotation<T>({ reducer })
    : Annotation<T>({ reducer, default: defaultValue });
}

/** A channel several nodes append to concurrently, in no fixed order. */
function appendTo<T>() {
  return Annotation<T[]>({
    reducer: (left: T[], right: T[]) => left.concat(right),
    default: (): T[] => [],
  });
}

/** What `join` derives from the agent outcomes. */
interface JoinedCandidates {
  /** Untrusted candidate findings, in agent order. */
  candidates: unknown[];
  /** Agents that failed while at least one other agent succeeded. */
  agentFailures: AgentFailure[];
}

/**
 * What the `synthesise` node writes.
 *
 * A discriminated union on `outcome` rather than one shape with
 * optional fields, matching how the rest of the repository models "it
 * worked, or it didn't and here's why" (AgentOutputResult,
 * ToolDispatchResult, EventInspection, ActionResult). That makes the
 * invariants structural instead of documentary: `error` exists ONLY on
 * the failed branch, and `durationMs` only where a model call was
 * actually timed, so a "completed" state carrying an error — or a
 * "failed" one carrying no reason — cannot be constructed at all.
 *
 * `candidates` and `usage` sit on every branch because
 * ReviewPipelineResult promises both unconditionally: the raw
 * candidates are the fallback a failed synthesis publishes, and usage
 * is zero rather than absent when no call was made.
 */
type SynthesisState =
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

/**
 * The graph's channels, one per node that writes it. Grouping by
 * WRITER rather than by field is what collapses eleven channels into
 * five: `join` produces one value and `synthesise` produces one, so
 * each node's output is a channel and the state reads like the flow.
 */
const ReviewGraphState = Annotation.Root({
  /**
   * The loaded PR context every agent reviews. Set once at invoke, and
   * the single source of truth for the PR's changed files: the agents
   * and the final validation step both read `context.changedFiles`, so
   * validation can never filter against a different list than the one
   * the agents saw.
   */
  context: lastWins<ReviewContext>(),
  /**
   * One entry per agent node. The ONLY channel with a meaningful
   * reducer: every agent node writes it in the same superstep, so the
   * writes are concatenated and `join` re-sorts them by `index`.
   */
  agentOutcomes: appendTo<AgentOutcome>(),
  joined: lastWins<JoinedCandidates>(() => ({
    candidates: [],
    agentFailures: [],
  })),
  synthesis: lastWins<SynthesisState>(() => ({
    outcome: "skipped",
    candidates: [],
    usage: emptyTokenUsage(),
  })),
  /** The final, deterministically validated findings. */
  findings: lastWins<ReviewFinding[]>(() => []),
});

type ReviewGraphUpdate = typeof ReviewGraphState.Update;
type ReviewGraphStateT = typeof ReviewGraphState.State;

/** One node per agent: runs it and records success or failure, never throws. */
function agentNode(
  index: number,
  agent: ReviewAgent,
): (state: ReviewGraphStateT) => Promise<ReviewGraphUpdate> {
  return async (state) => {
    try {
      const candidates = await agent.run(state.context);
      return {
        agentOutcomes: [{ index, name: agent.name, candidates: [...candidates] }],
      };
    } catch (error) {
      return {
        agentOutcomes: [{ index, name: agent.name, error: errorMessage(error) }],
      };
    }
  };
}

/**
 * The fan-in point: waits for every agent node (LangGraph only runs a
 * node once all of its incoming edges' sources have completed), then
 * derives `candidates` / `agentFailures` in the agents' original order
 * — never completion order — and throws when every agent failed.
 */
function makeJoinNode(agentCount: number) {
  return (state: ReviewGraphStateT): ReviewGraphUpdate => {
    const ordered = [...state.agentOutcomes].sort((a, b) => a.index - b.index);
    const candidates: unknown[] = [];
    const agentFailures: AgentFailure[] = [];
    for (const outcome of ordered) {
      if (outcome.error !== undefined) {
        agentFailures.push({ agent: outcome.name, error: outcome.error });
      } else {
        candidates.push(...(outcome.candidates ?? []));
      }
    }

    if (agentFailures.length === agentCount) {
      const details = agentFailures
        .map((failure) => `${failure.agent}: ${failure.error}`)
        .join("; ");
      throw new Error(`every review agent failed — ${details}`);
    }

    return { joined: { candidates, agentFailures } };
  };
}

/**
 * The synthesis step. Zero candidates means nothing to refine, so the
 * Synthesiser is not invoked at all — that is what "skipped" reports.
 * (The Synthesiser separately skips its own model call when candidates
 * exist but none are well-formed; that still counts as "completed"
 * here, since this node only reports whether it invoked it.)
 *
 * A failure falls back to the raw candidates, never failing the review.
 */
function makeSynthesiseNode(synthesiser: Synthesiser) {
  return async (state: ReviewGraphStateT): Promise<ReviewGraphUpdate> => {
    const { candidates } = state.joined;
    if (candidates.length === 0) {
      return {
        synthesis: {
          outcome: "skipped",
          candidates: [],
          usage: emptyTokenUsage(),
        },
      };
    }

    const startedAt = Date.now();
    try {
      const result = await synthesiser.synthesise(candidates);
      return {
        synthesis: {
          outcome: "completed",
          candidates: result.findings,
          usage: result.usage,
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      return {
        synthesis: {
          outcome: "failed",
          // The fallback: the RAW candidates still flow to validation.
          candidates,
          usage: emptyTokenUsage(),
          error: errorMessage(error),
          errorName: errorName(error),
          durationMs: Date.now() - startedAt,
        },
      };
    }
  };
}

/** The deterministic validation chain: never trust AI output. */
function validateNode(state: ReviewGraphStateT): ReviewGraphUpdate {
  return {
    findings: validateFindings(
      state.synthesis.candidates,
      state.context.changedFiles,
    ),
  };
}

/** Compiles the graph above for one set of agents and one Synthesiser. */
export function buildReviewGraph(
  agents: readonly ReviewAgent[],
  synthesiser: Synthesiser,
) {
  if (agents.length === 0) {
    throw new Error("buildReviewGraph requires at least one review agent");
  }

  // The node-name generic is pinned to `string` up front: LangGraph's
  // fluent builder normally accumulates a literal-string union of node
  // names from each addNode() call so addEdge() can check them at
  // compile time, but that only works for a statically known chain —
  // here the agent node names come from the runtime `agents` list.
  const graph = new StateGraph<
    typeof ReviewGraphState,
    ReviewGraphStateT,
    ReviewGraphUpdate,
    string
  >(ReviewGraphState);
  const agentNodeNames = agents.map((agent, index) => {
    const nodeName = `agent__${agent.name}`;
    graph.addNode(nodeName, agentNode(index, agent));
    graph.addEdge(START, nodeName);
    return nodeName;
  });

  return graph
    .addNode("join", makeJoinNode(agents.length))
    .addEdge(agentNodeNames, "join")
    .addNode("synthesise", makeSynthesiseNode(synthesiser))
    .addEdge("join", "synthesise")
    .addNode("validate", validateNode)
    .addEdge("synthesise", "validate")
    .addEdge("validate", END)
    .compile();
}

/** The full outcome of one review-pipeline run, for the caller to log and publish. */
export interface ReviewPipelineResult {
  /** Untrusted candidate findings from every successful agent, in agent order. */
  candidates: unknown[];
  /** Agents that failed while at least one other agent succeeded. */
  agentFailures: AgentFailure[];
  /** How many candidates the synthesiser (or the raw fallback) produced. */
  synthesisedCandidateCount: number;
  synthesisOutcome: "skipped" | "completed" | "failed";
  synthesisError?: string;
  synthesisErrorName?: string;
  /** The synthesiser's single-call token usage; zero when skipped. */
  synthesisUsage: TokenUsage;
  /** Wall-clock time spent in the synthesise node; unset when skipped. */
  synthesisDurationMs?: number;
  /** The final, deterministically validated findings. */
  findings: ReviewFinding[];
}

/**
 * Runs the full pipeline — agents, synthesis, validation — for one
 * review, and flattens the final graph state into a plain result.
 *
 * Throws when every agent failed, so the workflow step fails and the
 * run can be retried. A synthesis failure never throws.
 */
export async function runReviewPipeline(
  agents: readonly ReviewAgent[],
  synthesiser: Synthesiser,
  context: ReviewContext,
): Promise<ReviewPipelineResult> {
  const graph = buildReviewGraph(agents, synthesiser);
  const { joined, synthesis, findings } = await graph.invoke({ context });

  // The grouped channels are flattened back out here, deliberately.
  // Grouping is what keeps the GRAPH readable; the result is a record
  // an operator logs and an evaluation prints, and those read better
  // flat. This function is the only place the two shapes meet.
  return {
    candidates: joined.candidates,
    agentFailures: joined.agentFailures,
    synthesisedCandidateCount: synthesis.candidates.length,
    synthesisOutcome: synthesis.outcome,
    synthesisUsage: synthesis.usage,
    // Narrowed rather than read blindly: the union is what guarantees
    // an error is only ever reported for a synthesis that actually
    // failed, and a duration only for one that actually ran.
    ...(synthesis.outcome === "failed"
      ? {
          synthesisError: synthesis.error,
          synthesisErrorName: synthesis.errorName,
        }
      : {}),
    ...(synthesis.outcome === "skipped"
      ? {}
      : { synthesisDurationMs: synthesis.durationMs }),
    findings,
  };
}
