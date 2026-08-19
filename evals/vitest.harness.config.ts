/**
 * The evaluation harness's own tests: fixture loading, generated
 * diffs, the fixture-backed GitHub client, and the expectation logic,
 * all driven through the real pipeline with scripted agents.
 *
 * These are deterministic and call no model, so they belong to the
 * fast unit run — the root vitest.config.ts includes this project.
 * They match only `*.test.ts`; the model-backed `*.eval.ts` files are
 * outside this project's include pattern.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/** This directory, so the config works from any working directory. */
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root,
    name: "evals-harness",
    include: ["src/**/*.test.ts"],
  },
});
