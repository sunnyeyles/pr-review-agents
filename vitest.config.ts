/**
 * The fast unit run (`pnpm test`). Projects are listed explicitly, which
 * is what keeps the model-backed `*.eval.ts` evaluations out of it.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*", "evals/vitest.harness.config.ts"],
  },
});
