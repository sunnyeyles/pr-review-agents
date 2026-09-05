/**
 * Publishes this build's system prompts to Langfuse.
 * Usage: node scripts/seed-prompts.mjs [--label <name>] [--dry-run]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Bundled, not imported: scripts/ is not a workspace project, so nothing here
// resolves @pr-review/ai. The prompts reach it the way the runner gets them.
import { bundle } from "./lib/bundle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(repoRoot, "apps/action/src/seed-prompts-cli.ts");

/**
 * Reads .env.local into a plain object. Quotes are stripped and `export `
 * tolerated, so a file that can be `source`d in a shell also works here.
 */
function readEnvFile(file) {
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return {};
  }

  const values = {};
  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

// The real environment wins over the file, so a one-off
// LANGFUSE_BASE_URL=… on the command line behaves as expected.
const env = { ...readEnvFile(path.join(repoRoot, ".env.local")), ...process.env };

// A missing prompt is the normal unseeded case, but the SDK logs each 404 with
// a full response dump. Read from the real environment, not the object above.
process.env["LANGFUSE_LOG_LEVEL"] ??= "NONE";

const work = mkdtempSync(path.join(tmpdir(), "pr-review-seed-"));
try {
  const outfile = path.join(work, "seed.mjs");
  await bundle({ entryPoint, outfile, logLevel: "warning" });

  const cli = await import(pathToFileURL(outfile).href);
  // The CLI owns its own SDK client, logger, and output stream; this
  // script owns only where credentials came from.
  const { env: _processEnv, ...rest } = cli.seedCliEnvironment();
  process.exitCode = await cli.main(process.argv.slice(2), { env, ...rest });
} finally {
  rmSync(work, { recursive: true, force: true });
}
