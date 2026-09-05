/**
 * Publishes this build's system prompts to Langfuse.
 *
 * Usage: node scripts/seed-prompts.mjs [--label <name>] [--dry-run]
 *        pnpm seed-prompts -- --dry-run
 *
 * The prompts reach this script the same way they reach the Actions
 * runner — through esbuild. Copying the text in here would create a
 * second definition of the exact thing the contract guard protects.
 */
import { runBundledCli } from "./lib/run-bundled-cli.mjs";

await runBundledCli({
  entry: "apps/action/src/seed-prompts-cli.ts",
  prefix: "pr-review-seed-",
  createEnvironment: (cli) => cli.seedCliEnvironment(),
});
