/**
 * A LangGraph playground — NOT part of the shipped pipeline.
 *
 * Three runnable experiments that expose the mechanics `review-graph.ts`
 * and `agent-runtime.ts` rely on. Run just this file with:
 *
 *   pnpm vitest run langgraph-playground
 *
 * Add `--reporter=verbose` to read the execution-order log as it happens.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Experiment 1 — supersteps are real, and concurrency is implicit.
 *
 * Three nodes fan out from START with deliberately staggered delays.
 * They all run in ONE superstep, against the SAME frozen snapshot, and
 * their writes are folded by the reducer. `join` runs only after all
 * three have settled, because addEdge([...], "join") is a barrier.
 * ------------------------------------------------------------------ */

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

/**
 * Completion order, recorded outside the graph.
 *
 * State writes are folded by the reducer at the end of the superstep,
 * so `trace` cannot tell you who finished first. This can.
 */
const completions: string[] = [];

function tracer(name: string, delayMs: number) {
  return async (state: typeof TraceState.State): Promise<typeof TraceState.Update> => {
    // The snapshot is frozen at the start of the superstep: every one of
    // the three nodes sees `trace` as [] here, no matter who finishes first.
    const sawOnEntry = state.trace.length;
    await sleep(delayMs);
    completions.push(name);
    return { trace: [`${name}(saw ${sawOnEntry} entries on entry)`] };
  };
}

describe("experiment 1: supersteps and the fan-in barrier", () => {
  it("runs fan-out nodes concurrently against one frozen snapshot", async () => {
    const graph = new StateGraph(TraceState)
      .addNode("slow", tracer("slow", 30))
      .addNode("medium", tracer("medium", 15))
      .addNode("fast", tracer("fast", 1))
      .addEdge(START, "slow")
      .addEdge(START, "medium")
      .addEdge(START, "fast")
      // A node must be declared before an edge can name it — the
      // builder's node-name union grows as you add them.
      .addNode("join", (state) => ({ sawAtJoin: state.trace.length }))
      // The ARRAY form is a barrier: `join` waits for all three.
      // Three separate addEdge(x, "join") calls would NOT be equivalent.
      .addEdge(["slow", "medium", "fast"], "join")
      .addEdge("join", END)
      .compile();

    completions.length = 0;
    const final = await graph.invoke({});

    // Concurrency, proved without a stopwatch: the three nodes are
    // dispatched slowest-first, so a sequential runner would finish them
    // in dispatch order. Finishing in DURATION order means they
    // overlapped. Asserting on elapsed milliseconds instead would make
    // this test a load-dependent coin flip on a busy CI runner.
    expect(completions).toEqual(["fast", "medium", "slow"]);

    // Every node saw an EMPTY trace on entry — proof of the frozen snapshot.
    for (const entry of final.trace) {
      expect(entry).toContain("saw 0 entries on entry");
    }

    // And `join` only ran once all three writes were reduced in.
    expect(final.sawAtJoin).toBe(3);

    console.log("experiment 1 trace:", final.trace);
  });
});

/* ------------------------------------------------------------------ *
 * Experiment 2 — a cycle, exactly like agent-runtime.ts's loop.
 *
 * `work` either routes back to itself via `tick` or exits to END. This
 * is the same shape as callModel <-> callTools, minus the model.
 * ------------------------------------------------------------------ */

const LoopState = Annotation.Root({
  turn: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  log: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  done: Annotation<boolean>({ reducer: (_l, r) => r, default: () => false }),
});

describe("experiment 2: cycles via conditional edges", () => {
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

/* ------------------------------------------------------------------ *
 * Experiment 3 — the reducer as a concurrency contract.
 *
 * Three scanner nodes each report the worst severity THEY found, all in
 * the same superstep, all with different durations. The graph must end
 * up reporting "high" — and it must do so no matter which scanner wins
 * the race. That property lives entirely in the reducer.
 *
 * This is the same class of problem review-graph.ts solves at line 147
 * by sorting `agentOutcomes` on an explicit `index` instead of trusting
 * arrival order.
 * ------------------------------------------------------------------ */

export type Severity = "none" | "low" | "medium" | "high";

/** Severity ordering, worst last. Useful for comparing two severities. */
export const SEVERITY_RANK: readonly Severity[] = ["none", "low", "medium", "high"];

/**
 * The reducer for the `worst` channel.
 *
 * `left` is the value already in the channel, `right` is one write from
 * one scanner node in the current superstep. LangGraph calls this once
 * per write, folding them in an order you do NOT control — so the merge
 * has to be order-independent. The obvious-looking
 * `(_left, right) => right` is last-write-wins, which here means
 * whichever scanner happened to finish last decides the answer.
 *
 * Taking the max by rank is commutative, so the result is the same
 * either way round.
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
    // An array edge needs a real node on the far side: END cannot be
    // the target of a barrier, so a no-op node stands in for one.
    .addNode("collect", () => ({}))
    .addEdge(["scanLow", "scanMedium", "scanHigh"], "collect")
    .addEdge("collect", END)
    .compile();
}

describe("experiment 3: the reducer is the concurrency contract", () => {
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
