/**
 * The on-demand model-backed quality suite. Its own config, matching
 * only `*.eval.ts`, so the fast unit run can never pick it up.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/** This directory, so the config works from any working directory. */
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root,
    name: "evals",
    include: ["src/**/*.eval.ts"],
    // No key, no run: this refuses to start before any test file is
    // imported, so a keyless run makes no model call.
    globalSetup: ["src/model-access.setup.ts"],
    // One fixture is a full review: three agentic loops plus
    // synthesis, each with its own tool round trips.
    testTimeout: 60_000,
    hookTimeout: 900_000,
    // Fixtures run one at a time: a quality report is read top to
    // bottom, and interleaved reviews make it unreadable.
    fileParallelism: false,
    sequence: { concurrent: false },
    // A retry would quietly turn a flaky reviewer into a passing one.
    retry: 0,
  },
});
