/**
 * What each agent actually looked at, in the order it looked. Built
 * from the `agent.tool` events the runtime emits, so the trace is the
 * production log stream, not an evaluation-only side channel.
 */
import type { CapturedLogEvent } from "@pr-review/logging";

/** One repository read, as one agent performed it. */
export interface ReadStep {
  /** 1-based within this agent's run; agents run concurrently. */
  sequence: number;
  /** Model call the read was requested on. */
  turn: number;
  tool: string;
  /** Path or search query, absent for the whole-pull-request tools. */
  target?: string;
  ok: boolean;
  durationMs?: number;
  resultChars?: number;
  error?: string;
}

/** One agent's reads, in order. */
export interface AgentReadTrace {
  agent: string;
  steps: ReadStep[];
}

function stringField(entry: CapturedLogEvent, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(entry: CapturedLogEvent, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Groups the run's tool events by agent. Agents appear in the order
 * their first read landed, and each agent's steps are sorted by the
 * runtime's own counter rather than by arrival.
 */
export function buildReadTrace(
  events: readonly CapturedLogEvent[],
): AgentReadTrace[] {
  const byAgent = new Map<string, AgentReadTrace>();
  for (const entry of events) {
    if (entry.event !== "agent.tool") {
      continue;
    }
    const agent = stringField(entry, "agent") ?? "unknown";
    const tool = stringField(entry, "tool") ?? "unknown";
    let trace = byAgent.get(agent);
    if (trace === undefined) {
      trace = { agent, steps: [] };
      byAgent.set(agent, trace);
    }
    trace.steps.push({
      sequence: numberField(entry, "sequence") ?? trace.steps.length + 1,
      turn: numberField(entry, "turn") ?? 0,
      tool,
      target: stringField(entry, "target"),
      ok: entry.ok !== false,
      durationMs: numberField(entry, "durationMs"),
      resultChars: numberField(entry, "resultChars"),
      error: stringField(entry, "error"),
    });
  }
  for (const trace of byAgent.values()) {
    trace.steps.sort((a, b) => a.sequence - b.sequence);
  }
  return [...byAgent.values()];
}

/** The file paths one agent read, in first-read order, without repeats. */
export function filesRead(trace: AgentReadTrace): string[] {
  const seen: string[] = [];
  for (const step of trace.steps) {
    if (!step.ok || step.target === undefined) {
      continue;
    }
    if (step.tool !== "get_file" && step.tool !== "get_base_file") {
      continue;
    }
    if (!seen.includes(step.target)) {
      seen.push(step.target);
    }
  }
  return seen;
}

/** One step, rendered for the run report. */
function formatStep(step: ReadStep): string {
  const target = step.target === undefined ? "" : ` ${step.target}`;
  const outcome = step.ok
    ? step.resultChars === undefined
      ? ""
      : ` (${step.resultChars} chars)`
    : ` (FAILED: ${step.error ?? "unknown error"})`;
  return `${step.sequence}. ${step.tool}${target}${outcome}`;
}

/** Every agent's reads, in order, as report lines. */
export function formatReadTrace(traces: readonly AgentReadTrace[]): string {
  if (traces.length === 0) {
    return "  read order:    (no tool calls)";
  }
  const lines: string[] = ["  read order:"];
  for (const trace of traces) {
    lines.push(`    ${trace.agent} (${trace.steps.length} call(s)):`);
    for (const step of trace.steps) {
      lines.push(`      ${formatStep(step)}`);
    }
  }
  return lines.join("\n");
}
