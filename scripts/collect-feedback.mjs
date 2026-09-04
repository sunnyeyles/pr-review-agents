/**
 * Turns thumbs reactions on review comments into Langfuse scores.
 *
 * Usage: node scripts/collect-feedback.mjs [--repo owner/name] [--since-days N] [--dry-run]
 *        pnpm collect-feedback -- --dry-run
 *
 * Bundles the CLI for the same reason seed-prompts.mjs does: scripts/ is
 * not a workspace project, so nothing here can import @pr-review/*
 * without esbuild rewriting the workspace specifiers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bundle } from "./lib/bundle.mjs";
import { readEnvFile } from "./lib/env-file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(repoRoot, "apps/action/src/collect-feedback-cli.ts");

// The real environment wins over the file, so Actions secrets are used as-is.
const env = { ...readEnvFile(path.join(repoRoot, ".env.local")), ...process.env };

process.env["LANGFUSE_LOG_LEVEL"] ??= "NONE";

const work = mkdtempSync(path.join(tmpdir(), "pr-review-feedback-"));
try {
  const outfile = path.join(work, "collect-feedback.mjs");
  await bundle({ entryPoint, outfile, logLevel: "warning" });

  const cli = await import(pathToFileURL(outfile).href);
  const { env: _processEnv, ...rest } = cli.collectCliEnvironment();
  process.exitCode = await cli.main(process.argv.slice(2), { env, ...rest });
} finally {
  rmSync(work, { recursive: true, force: true });
}
