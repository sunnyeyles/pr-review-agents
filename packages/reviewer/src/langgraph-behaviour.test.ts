/**
 * Pins the LangGraph behaviour review-graph.ts depends on, so an upgrade
 * that changes it fails here rather than in the pipeline.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* Supersteps are real, and concurrency is implicit. */

const TraceState = Annotation.Root({
  /** Append-only: three nodes write this channel in the same superstep. */
  trace: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** Single writer (`join` only), so last-write-wins is safe here. */
  sawAtJoin: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
});

/** Completion order: reduced state cannot tell you who finished first, this can. */
const completions: string[] = [];

function tracer(name: string, delayMs: number) {
  return async (state: typeof TraceState.State): Promise<typeof TraceState.Update> => {
    // The snapshot is frozen at the start of the superstep.
    const sawOnEntry = state.trace.length;
    await sleep(delayMs);
    completions.push(name);
    return { trace: [`${name}(saw ${sawOnEntry} entries on entry)`] };
  };
}

describe("supersteps and the fan-in barrier", () => {
  it("runs fan-out nodes concurrently against one frozen snapshot", async () => {
    const graph = new StateGraph(TraceState)
      .addNode("slow", tracer("slow", 30))
      .addNode("medium", tracer("medium", 15))
      .addNode("fast", tracer("fast", 1))
      .addEdge(START, "slow")
      .addEdge(START, "medium")
      .addEdge(START, "fast")
      // A node must be declared before an edge can name it.
      .addNode("join", (state) => ({ sawAtJoin: state.trace.length }))
      // The array form is a barrier; three separate addEdge calls are not.
      .addEdge(["slow", "medium", "fast"], "join")
      .addEdge("join", END)
      .compile();

    completions.length = 0;
    const final = await graph.invoke({});

    // Dispatched slowest-first, so finishing in duration order proves
    // they overlapped — without a load-dependent stopwatch assertion.
    expect(completions).toEqual(["fast", "medium", "slow"]);

    // Every node saw an empty trace on entry: the snapshot was frozen.
    for (const entry of final.trace) {
      expect(entry).toContain("saw 0 entries on entry");
    }

    expect(final.sawAtJoin).toBe(3);

    
  });
});

/* A cycle, the same shape as the agents/runtime.ts tool loop. */

const LoopState = Annotation.Root({
  turn: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  log: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  done: Annotation<boolean>({ reducer: (_l, r) => r, default: () => false }),
});

describe("cycles via conditional edges", () => {
  it("loops until the router sends it to END", async () => {
    const MAX_TURNS = 3;

    const graph = new StateGraph(LoopState)
      .addNode("work", (state) => {
        const turn = state.turn + 1;
        return { turn, log: [`work turn ${turn}`], done: turn >= MAX_TURNS };
      })
      .addNode("tick", (state) => ({ log: [`tick after turn ${state.turn}`] }))
      .addEdge(START, "work")
      .addConditionalEdges("work", (state) => (state.done ? END : "tick"), {
        tick: "tick",
        [END]: END,
      })
      .addEdge("tick", "work")
      .compile();

    const final = await graph.invoke({});

    expect(final.turn).toBe(MAX_TURNS);
    expect(final.log).toEqual([
      "work turn 1",
      "tick after turn 1",
      "work turn 2",
      "tick after turn 2",
      "work turn 3",
    ]);
  });
});

/*
 * The reducer as a concurrency contract. Three scanners
 * race; the result must be "high" whichever one wins.
 */

export type Severity = "none" | "low" | "medium" | "high";

/** Severity ordering, worst last. Useful for comparing two severities. */
export const SEVERITY_RANK: readonly Severity[] = ["none", "low", "medium", "high"];

/**
 * LangGraph folds writes in an order you do not control, so the merge
 * must be order-independent. Max-by-rank is commutative; last-wins is not.
 */
export const worstSeverityReducer = (left: Severity, right: Severity): Severity =>
  SEVERITY_RANK.indexOf(right) > SEVERITY_RANK.indexOf(left) ? right : left;

const ScanState = Annotation.Root({
  worst: Annotation<Severity>({
    reducer: worstSeverityReducer,
    default: () => "none" as Severity,
  }),
});

function scanner(found: Severity, delayMs: number) {
  return async (): Promise<typeof ScanState.Update> => {
    await sleep(delayMs);
    return { worst: found };
  };
}

/** Same three findings, but which node finishes first is swapped. */
function buildScanGraph(delays: { low: number; medium: number; high: number }) {
  return new StateGraph(ScanState)
    .addNode("scanLow", scanner("low", delays.low))
    .addNode("scanMedium", scanner("medium", delays.medium))
    .addNode("scanHigh", scanner("high", delays.high))
    .addEdge(START, "scanLow")
    .addEdge(START, "scanMedium")
    .addEdge(START, "scanHigh")
    // END cannot be the target of a barrier, so a no-op node stands in.
    .addNode("collect", () => ({}))
    .addEdge(["scanLow", "scanMedium", "scanHigh"], "collect")
    .addEdge("collect", END)
    .compile();
}

describe("the reducer is the concurrency contract", () => {
  it("merges two writes order-independently", () => {
    expect(worstSeverityReducer("low", "high")).toBe("high");
    expect(worstSeverityReducer("high", "low")).toBe("high");
    expect(worstSeverityReducer("none", "medium")).toBe("medium");
  });

  it("reports the worst severity when the high scanner finishes LAST", async () => {
    const final = await buildScanGraph({ low: 1, medium: 10, high: 25 }).invoke({});
    expect(final.worst).toBe("high");
  });

  it("reports the worst severity when the high scanner finishes FIRST", async () => {
    const final = await buildScanGraph({ low: 25, medium: 10, high: 1 }).invoke({});
    expect(final.worst).toBe("high");
  });
});
