/**
 * Refuses to start without model credentials. Runs before any test file
 * is imported, so a keyless run makes no model call at all.
 */
import process from "node:process";

import { ModelProviderError } from "@pr-review/ai";

import { requireModelAccess } from "./model-access.js";

export default function setup(): void {
  try {
    requireModelAccess(process.env);
  } catch (error) {
    // A misspelt provider is not a missing key; its own message says so.
    if (error instanceof ModelProviderError) {
      throw error;
    }
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    throw new Error("Model credentials are not set — the agent evaluations cannot run");
  }
}
