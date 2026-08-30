/**
 * The evaluation harness's own tests. Deterministic and model-free, so
 * they join the fast unit run; matches `*.test.ts` only.
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
