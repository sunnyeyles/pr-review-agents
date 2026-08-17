/**
 * The review pipeline as one LangGraph StateGraph:
 *
 *   START --> agent__correctness --\
 *         \-> agent__security     --> join --> synthesise --> validate --> END
 *          \-> agent__architecture-/
 *
 * Partial failure: one failed agent does not fail the review while at
 * least one other succeeded; when EVERY agent fails, `join` throws so
 * the whole invocation rejects. Outcomes are re-sorted by the agent's
 * position in the input list, so the result never depends on which
 * agent happens to settle first.
 *
 * Synthesis has two non-model paths: zero candidates skips the model
 * call entirely, and a synthesis failure falls back to the RAW
 * candidates rather than failing the review — the caller reads
 * `synthesisOutcome` / `synthesisError` to log accordingly.
 *
 * `validate` is the ONLY node whose output the caller may treat as
 * trustworthy.
 */
import { emptyTokenUsage, type ReviewAgent, type ReviewContext, type TokenUsage } from "@pr-review/ai";
import type { ChangedFile } from "@pr-review/github";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ReviewGraphState = Annotation.Root({
  /** The loaded PR context every agent reviews. Set once at invoke. */
  context: Annotation<ReviewContext>({ reducer: (_left, right) => right }),
  /** The PR's changed files, for the final validation step. */
  changedFiles: Annotation<readonly ChangedFile[]>({
    reducer: (_left, right) => right,
  }),
  /** One entry per agent node, merged (order-independent) by `join`. */
  agentOutcomes: Annotation<AgentOutcome[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** Untrusted candidate findings, in agent order, set by `join`. */
  candidates: Annotation<unknown[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  agentFailures: Annotation<AgentFailure[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  /** The synthesiser's refined candidates, or the raw ones on fallback. */
  synthesisedCandidates: Annotation<unknown[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  synthesisOutcome: Annotation<"skipped" | "completed" | "failed">({
    reducer: (_left, right) => right,
    default: () => "skipped",
  }),
  synthesisError: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  synthesisErrorName: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  /** The synthesiser's single-call token usage; zero when skipped. */
  synthesisUsage: Annotation<TokenUsage>({
    reducer: (_left, right) => right,
    default: emptyTokenUsage,
  }),
  /** Wall-clock time spent in the synthesise node; unset when skipped. */
  synthesisDurationMs: Annotation<number | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  /** The final, deterministically validated findings. */
  findings: Annotation<ReviewFinding[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
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

    return { candidates, agentFailures };
  };
}

/**
 * The synthesis step. Empty-input choice (documented): with no
 * candidates at all there is nothing to refine, so the model call is
 * skipped entirely — the Synthesiser itself additionally skips its
 * model call when candidates exist but none are well-formed, which
 * still counts as "completed" here since the boundary this node
 * reports on is whether it invoked the Synthesiser at all. A synthesis
 * failure falls back to the raw candidates rather than failing the
 * review.
 */
function makeSynthesiseNode(synthesiser: Synthesiser) {
  return async (state: ReviewGraphStateT): Promise<ReviewGraphUpdate> => {
    if (state.candidates.length === 0) {
      return { synthesisedCandidates: [], synthesisOutcome: "skipped" };
    }

    const startedAt = Date.now();
    try {
      const result = await synthesiser.synthesise(state.candidates);
      return {
        synthesisedCandidates: result.findings,
        synthesisOutcome: "completed",
        synthesisUsage: result.usage,
        synthesisDurationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        synthesisedCandidates: state.candidates,
        synthesisOutcome: "failed",
        synthesisError: errorMessage(error),
        synthesisErrorName: error instanceof Error ? error.name : "Error",
        synthesisDurationMs: Date.now() - startedAt,
      };
    }
  };
}

/** The deterministic validation chain: never trust AI output. */
function validateNode(state: ReviewGraphStateT): ReviewGraphUpdate {
  return {
    findings: validateFindings(state.synthesisedCandidates, state.changedFiles),
  };
}

/**
 * Builds the compiled review pipeline graph for one set of agents and
 * one Synthesiser. Agents run as parallel nodes fanning out from START;
 * `join`, `synthesise`, and `validate` run in sequence after every
 * agent settles.
 */
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
 * review job. Throws when every agent failed (the review itself fails
 * so the job is retried and eventually dead-lettered by SQS); a
 * synthesis failure never throws, it is reported on the result instead.
 */
export async function runReviewPipeline(
  agents: readonly ReviewAgent[],
  synthesiser: Synthesiser,
  context: ReviewContext,
  changedFiles: readonly ChangedFile[],
): Promise<ReviewPipelineResult> {
  const graph = buildReviewGraph(agents, synthesiser);
  const finalState = await graph.invoke({ context, changedFiles });

  return {
    candidates: finalState.candidates,
    agentFailures: finalState.agentFailures,
    synthesisedCandidateCount: finalState.synthesisedCandidates.length,
    synthesisOutcome: finalState.synthesisOutcome,
    synthesisError: finalState.synthesisError,
    synthesisErrorName: finalState.synthesisErrorName,
    synthesisUsage: finalState.synthesisUsage,
    synthesisDurationMs: finalState.synthesisDurationMs,
    findings: finalState.findings,
  };
}
