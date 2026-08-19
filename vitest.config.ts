/**
 * The fast unit run (`pnpm test`): every workspace package, plus the
 * evaluation harness's own deterministic tests.
 *
 * The projects are listed explicitly, and that list is what keeps the
 * model-backed agent evaluations out of it. `evals/` is not matched by
 * either glob, and the one evaluation project named here —
 * vitest.harness.config.ts — includes `src/**\/*.test.ts` only, while
 * every evaluation that calls the real model is a `*.eval.ts` file.
 * The evaluations have their own config (evals/vitest.eval.config.ts)
 * and their own command (`pnpm eval`), so they never run by accident,
 * never cost tokens in CI, and never make the unit suite flaky.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*", "evals/vitest.harness.config.ts"],
  },
});
