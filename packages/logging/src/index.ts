/**
 * The shared structured-logging seam: every lifecycle event is one
 * single-line JSON object. Fields must be JSON-serialisable and must
 * never contain secrets.
 */
type LogLevel = "info" | "error";

/** Extra structured fields on one log line. Never include secrets. */
type LogFields = Record<string, unknown>;

/** The structured logger every pipeline stage receives. */
export interface StructuredLogger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function logLine(level: LogLevel, event: string, fields: LogFields): string {
  // JSON.stringify drops undefined-valued fields, keeping lines clean.
  return JSON.stringify({ level, event, ...fields });
}

/** The production logger: info to stdout, error to stderr. */
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

interface CapturingLogger {
  logger: StructuredLogger;
  /** Every event logged so far, in emission order. */
  entries: CapturedLogEvent[];
}

/** Records events into an array instead of the console; no test-framework dependency. */
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

/** The message to log for a thrown value; a `catch` binding is `unknown`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The error name to log for a thrown value; "Error" when unknown. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}
