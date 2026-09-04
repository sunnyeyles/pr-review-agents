/**
 * Persists a run's read traces as JSON Lines, so two runs of the same
 * fixture can be diffed: what the agents opened, and in what order.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentReadTrace } from "./read-trace.js";

/** Overrides where traces are written; unset uses `evals/.traces`. */
export const TRACE_DIR_ENV = "EVAL_TRACE_DIR";

/** Set to "0" to write nothing. */
export const TRACE_ENV = "EVAL_TRACE";

const defaultDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".traces");

/** One line of the trace file: one read, fully identified. */
interface TraceLine extends Record<string, unknown> {
  runId: string;
  fixture: string;
  agent: string;
  sequence: number;
}

export interface TraceWriter {
  /** Where lines are going, for the report; undefined when disabled. */
  path: string | undefined;
  write(fixture: string, traces: readonly AgentReadTrace[]): void;
}

/** A writer for one `pnpm eval` run; the file is named after its start. */
export function createTraceWriter(
  env: NodeJS.ProcessEnv,
  now: Date = new Date(),
): TraceWriter {
  if (env[TRACE_ENV] === "0") {
    return { path: undefined, write: () => {} };
  }
  const runId = now.toISOString().replace(/[:.]/g, "-");
  const path = join(env[TRACE_DIR_ENV] ?? defaultDir, `${runId}.jsonl`);
  let opened = false;

  return {
    path,
    write(fixture, traces) {
      const lines: string[] = [];
      for (const trace of traces) {
        for (const step of trace.steps) {
          const line: TraceLine = {
            runId,
            fixture,
            agent: trace.agent,
            ...step,
          };
          lines.push(JSON.stringify(line));
        }
      }
      if (lines.length === 0) {
        return;
      }
      if (!opened) {
        mkdirSync(dirname(path), { recursive: true });
        opened = true;
      }
      appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
    },
  };
}
