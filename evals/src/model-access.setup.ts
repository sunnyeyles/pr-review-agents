/**
 * Vitest global setup for the evaluation project: refuse to start
 * without model credentials.
 *
 * This runs before any test file is imported, so a run without a key
 * makes no model call, loads no fixture, and exits non-zero with one
 * actionable message instead of three agent failures.
 */
import process from "node:process";

import { requireModelAccess, API_KEY_ENV } from "./model-access.js";

export default function setup(): void {
  try {
    requireModelAccess(process.env);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    throw new Error(`${API_KEY_ENV} is not set — the agent evaluations cannot run`);
  }
}
