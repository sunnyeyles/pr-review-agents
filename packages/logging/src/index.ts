/**
 * @pr-review/logging
 *
 * The shared structured-logging seam for spec §26 observability. Every
 * lifecycle event (review.received, review.queued, review.started,
 * agent.started/completed/failed, synthesis.*, review.published,
 * review.failed) is emitted through the StructuredLogger interface as
 * ONE single-line JSON object, which CloudWatch ingests as one
 * structured log event per line.
 *
 * Placement decision (ticket 10): logging lives in its own tiny
 * zero-dependency package rather than inside @pr-review/schemas, so
 * the schemas package stays purely data contracts (Zod schemas and
 * types) while logging remains a cross-cutting runtime concern that
 * every package and app can depend on without cycles.
 *
 * Seam convention: production code defaults to createConsoleLogger()
 * (stdout/stderr → CloudWatch); tests inject createCapturingLogger()
 * and assert on the recorded entries — no console spying required.
 *
 * Fields must be JSON-serialisable and must NEVER contain secrets
 * (tokens, keys, webhook secrets) — log identifiers, counts,
 * durations, and error messages only.
 */
export const LOGGING_PACKAGE = "@pr-review/logging";

export type LogLevel = "info" | "error";

/** Extra structured fields on one log line. Never include secrets. */
export type LogFields = Record<string, unknown>;

/**
 * The structured logger every pipeline stage receives. `info` records
 * normal lifecycle progress; `error` records failure events (routed to
 * stderr by the console logger so they stand out in CloudWatch).
 */
export interface StructuredLogger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function logLine(level: LogLevel, event: string, fields: LogFields): string {
  // JSON.stringify drops undefined-valued fields, keeping lines clean
  // when an optional value (e.g. token usage) is absent.
  return JSON.stringify({ level, event, ...fields });
}

/**
 * The production logger: one single-line JSON object per event, info
 * to stdout and error to stderr, both of which Lambda ships to
 * CloudWatch as individual log events.
 */
export function createConsoleLogger(): StructuredLogger {
  return {
    info(event, fields = {}) {
      console.log(logLine("info", event, fields));
    },
    error(event, fields = {}) {
      console.error(logLine("error", event, fields));
    },
  };
}

/** One event recorded by the capturing logger: level + event + fields, flattened. */
export interface CapturedLogEvent extends LogFields {
  level: LogLevel;
  event: string;
}

export interface CapturingLogger {
  logger: StructuredLogger;
  /** Every event logged so far, in emission order. */
  entries: CapturedLogEvent[];
}

/**
 * A logger that records events into an array instead of writing to the
 * console — the test-side of the seam (usable anywhere event buffering
 * is needed; it has no test-framework dependency).
 */
export function createCapturingLogger(): CapturingLogger {
  const entries: CapturedLogEvent[] = [];
  return {
    logger: {
      info(event, fields = {}) {
        entries.push({ ...fields, level: "info", event });
      },
      error(event, fields = {}) {
        entries.push({ ...fields, level: "error", event });
      },
    },
    entries,
  };
}
