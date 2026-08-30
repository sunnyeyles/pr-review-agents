/**
 * The review pipeline as one LangGraph StateGraph: agents run
 * concurrently, then join -> synthesise -> validate in sequence.
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

/** A channel exactly one node writes. With no default, it must be set at invoke. */
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

/** The graph's channels, one per node that writes it. */
const ReviewGraphState = Annotation.Root({
  /** Set once at invoke; the single source of truth for the PR's changed files. */
  context: lastWins<ReviewContext>(),
  /** Every agent writes in the same superstep, so writes concatenate; `join` re-sorts by `index`. */
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
 * Fan-in: derives candidates/failures in the agents' original order —
 * never completion order — and throws when every agent failed.
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
 * "skipped" means the Synthesiser was never invoked. A failure falls
 * back to the raw candidates rather than failing the review.
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

  // Node names are pinned to `string`: LangGraph's builder infers a
  // literal union, which cannot work for a runtime `agents` list.
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

/** Throws when every agent failed; a synthesis failure never throws. */
export async function runReviewPipeline(
  agents: readonly ReviewAgent[],
  synthesiser: Synthesiser,
  context: ReviewContext,
): Promise<ReviewPipelineResult> {
  const graph = buildReviewGraph(agents, synthesiser);
  const { joined, synthesis, findings } = await graph.invoke({ context });

  return {
    candidates: joined.candidates,
    agentFailures: joined.agentFailures,
    synthesisedCandidateCount: synthesis.candidates.length,
    synthesisOutcome: synthesis.outcome,
    synthesisUsage: synthesis.usage,
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
