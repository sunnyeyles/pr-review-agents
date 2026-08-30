/**
 * Refuses to start without model credentials. Runs before any test file
 * is imported, so a keyless run makes no model call at all.
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
