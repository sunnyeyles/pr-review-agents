/** Structured console logger; one JSON object per line. */
import type { Logger } from "./context.js";

function emit(level: string, event: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}

export const logger: Logger = {
  debug: (event, fields) => emit("debug", event, fields),
  info: (event, fields) => emit("info", event, fields),
};
