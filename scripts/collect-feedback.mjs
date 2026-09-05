/**
 * Turns thumbs reactions on review comments into Langfuse scores.
 *
 * Usage: node scripts/collect-feedback.mjs [--repo owner/name] [--since-days N] [--dry-run]
 *        pnpm collect-feedback -- --dry-run
 */
import { runBundledCli } from "./lib/run-bundled-cli.mjs";

await runBundledCli({
  entry: "apps/action/src/collect-feedback-cli.ts",
  prefix: "pr-review-feedback-",
  createEnvironment: (cli) => cli.collectCliEnvironment(),
});
