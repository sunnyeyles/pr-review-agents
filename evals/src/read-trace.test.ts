/**
 * The read trace: what each agent opened, in the order it opened it,
 * derived from the `agent.tool` events the runtime emits.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CapturedLogEvent } from "@pr-review/logging";
import { describe, expect, it } from "vitest";

import { evaluateExpectation } from "./expectations.js";
import { buildReadTrace, filesRead, formatReadTrace } from "./read-trace.js";
import type { FixtureReview } from "./run-fixture-review.js";
import { createTraceWriter, TRACE_DIR_ENV, TRACE_ENV } from "./trace-file.js";

/** One `agent.tool` event as the runtime logs it. */
function toolEvent(
  agent: string,
  sequence: number,
  tool: string,
  target?: string,
  overrides: Partial<CapturedLogEvent> = {},
): CapturedLogEvent {
  return {
    level: "info",
    event: "agent.tool",
    agent,
    sequence,
    turn: 1,
    tool,
    target,
    ok: true,
    durationMs: 3,
    resultChars: 120,
    ...overrides,
  };
}

/**
 * Interleaved, as concurrent agents log: the trace must recover each
 * agent's own order rather than the order events arrived.
 */
const events: CapturedLogEvent[] = [
  { level: "info", event: "agent.started", agent: "correctness" },
  toolEvent("correctness", 1, "get_diff"),
  toolEvent("security", 1, "get_file", "src/routes/customer-detail.ts"),
  toolEvent("correctness", 3, "get_file", "src/db/pool.ts", { turn: 2 }),
  toolEvent("correctness", 2, "get_file", "src/routes/admin-audit.ts"),
  toolEvent("security", 2, "get_file", "src/data/customers.ts"),
  toolEvent("security", 3, "get_file", "src/data/customers.ts", { turn: 2 }),
  { level: "info", event: "agent.completed", agent: "security" },
];

/** A review carrying only the parts the read expectations look at. */
function reviewWith(entries: CapturedLogEvent[]): FixtureReview {
  return {
    readTrace: buildReadTrace(entries),
    result: { findings: [] },
  } as unknown as FixtureReview;
}

describe("buildReadTrace", () => {
  it("groups reads by agent and orders each agent's own calls by sequence", () => {
    const traces = buildReadTrace(events);

    expect(traces.map((trace) => trace.agent)).toEqual(["correctness", "security"]);
    expect(traces[0]?.steps.map((step) => step.sequence)).toEqual([1, 2, 3]);
    expect(traces[0]?.steps.map((step) => step.tool)).toEqual([
      "get_diff",
      "get_file",
      "get_file",
    ]);
  });

  it("ignores every event that is not a tool call", () => {
    expect(buildReadTrace(events).flatMap((trace) => trace.steps)).toHaveLength(6);
    expect(buildReadTrace([{ level: "info", event: "agent.started" }])).toEqual([]);
  });

  it("keeps a failed call in the trace, with its error", () => {
    const traces = buildReadTrace([
      toolEvent("correctness", 1, "get_file", "nope.ts", {
        ok: false,
        error: "Not Found: nope.ts",
        resultChars: undefined,
      }),
    ]);

    expect(traces[0]?.steps[0]).toMatchObject({
      ok: false,
      error: "Not Found: nope.ts",
    });
  });
});

describe("filesRead", () => {
  it("lists file reads in first-read order, without repeats", () => {
    const [, security] = buildReadTrace(events);

    expect(filesRead(security!)).toEqual([
      "src/routes/customer-detail.ts",
      "src/data/customers.ts",
    ]);
  });

  it("counts neither a search nor a failed read as reading a file", () => {
    const [trace] = buildReadTrace([
      toolEvent("correctness", 1, "search_repository", "isAdmin"),
      toolEvent("correctness", 2, "get_file", "src/gone.ts", { ok: false }),
      toolEvent("correctness", 3, "get_base_file", "src/here.ts"),
    ]);

    expect(filesRead(trace!)).toEqual(["src/here.ts"]);
  });
});

describe("formatReadTrace", () => {
  it("renders each agent's calls in order, marking the failures", () => {
    const rendered = formatReadTrace(
      buildReadTrace([
        toolEvent("correctness", 1, "get_diff"),
        toolEvent("correctness", 2, "get_file", "src/gone.ts", {
          ok: false,
          error: "Not Found",
        }),
      ]),
    );

    expect(rendered).toContain("correctness (2 call(s)):");
    expect(rendered).toContain("1. get_diff");
    expect(rendered).toContain("2. get_file src/gone.ts (FAILED: Not Found)");
  });

  it("says so plainly when nothing was read", () => {
    expect(formatReadTrace([])).toContain("no tool calls");
  });
});

describe("the reads-file expectation", () => {
  it("passes when the named agent read the file", () => {
    const outcome = evaluateExpectation(reviewWith(events), {
      kind: "reads-file",
      description: "the security agent reads the data layer",
      agent: "security",
      file: "src/data/customers.ts",
    });

    expect(outcome.passed).toBe(true);
  });

  it("fails when the file was read, but by a different agent", () => {
    const outcome = evaluateExpectation(reviewWith(events), {
      kind: "reads-file",
      description: "the correctness agent reads the data layer",
      agent: "correctness",
      file: "src/data/customers.ts",
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("correctness read, in order:");
  });

  it("fails when the file was read too late to have driven the review", () => {
    const early = evaluateExpectation(reviewWith(events), {
      kind: "reads-file",
      description: "read early",
      agent: "security",
      file: "src/data/customers.ts",
      withinFirst: 1,
    });
    const late = evaluateExpectation(reviewWith(events), {
      kind: "reads-file",
      description: "read at all",
      agent: "security",
      file: "src/data/customers.ts",
      withinFirst: 2,
    });

    expect(early.passed).toBe(false);
    expect(early.detail).toContain("among its first 1");
    expect(late.passed).toBe(true);
  });

  it("accepts a read by any agent when none is named", () => {
    const outcome = evaluateExpectation(reviewWith(events), {
      kind: "reads-file",
      description: "someone read the pool",
      file: "src/db/pool.ts",
    });

    expect(outcome.passed).toBe(true);
  });

  it("says which agent never ran rather than reporting a missing read", () => {
    const outcome = evaluateExpectation(reviewWith(events), {
      kind: "reads-file",
      description: "the architecture agent reads the pool",
      agent: "architecture",
      file: "src/db/pool.ts",
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain('no agent named "architecture"');
  });
});

describe("the trace file", () => {
  it("writes one JSON line per read, identifying the run, fixture, and agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-trace-"));
    const writer = createTraceWriter(
      { [TRACE_DIR_ENV]: dir },
      new Date("2026-01-02T03:04:05.678Z"),
    );

    writer.write("security-tenant-scope", buildReadTrace(events));

    expect(writer.path).toBe(join(dir, "2026-01-02T03-04-05-678Z.jsonl"));
    const lines = readFileSync(writer.path!, "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      runId: "2026-01-02T03-04-05-678Z",
      fixture: "security-tenant-scope",
      agent: "correctness",
      sequence: 1,
      tool: "get_diff",
    });
  });

  it("appends fixtures to one file, so a run is one trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-trace-"));
    const writer = createTraceWriter({ [TRACE_DIR_ENV]: dir });

    writer.write("one", buildReadTrace(events));
    writer.write("two", buildReadTrace(events));

    const lines = readFileSync(writer.path!, "utf8").trim().split("\n");
    expect(lines).toHaveLength(12);
    expect(JSON.parse(lines[11]!)).toMatchObject({ fixture: "two" });
  });

  it("writes nothing when tracing is switched off", () => {
    const writer = createTraceWriter({ [TRACE_ENV]: "0" });

    writer.write("one", buildReadTrace(events));

    expect(writer.path).toBeUndefined();
  });
});
