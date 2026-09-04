/**
 * Publishes this build's system prompts to Langfuse.
 *
 * Usage: node scripts/seed-prompts.mjs [--label <name>] [--dry-run]
 *        pnpm seed-prompts -- --dry-run
 *
 * Why this script bundles instead of just importing the CLI: scripts/
 * is not a workspace project (pnpm-workspace.yaml covers apps/*,
 * packages/*, and evals), and .npmrc pins node-linker=isolated, so
 * nothing here can resolve @pr-review/ai or @langfuse/client. Node's
 * own TypeScript stripping cannot help either — the workspace sources
 * import each other with `.js` specifiers that resolve to `.ts` files,
 * which only a bundler rewrites.
 *
 * The alternative — copying the prompt text into this file — would
 * create a second definition of the exact thing the contract guard
 * exists to protect, and the copy would be wrong the first time
 * anyone edited an agent. So the prompts reach this script the same way
 * they reach the Actions runner: through esbuild.
 *
 * The bundle is a temporary artefact rather than dist/, because it is
 * a means of running the command once, not something anyone ships.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bundle } from "./lib/bundle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(repoRoot, "apps/action/src/seed-prompts-cli.ts");

/**
 * Reads .env.local into a plain object. It is gitignored and holds
 * local credentials — the README already points people there — but
 * nothing in the repository parsed it until now, and a dotenv
 * dependency for one file of `KEY=value` lines is not worth it.
 *
 * Quotes are stripped and `export ` prefixes tolerated, so a file that
 * can be `source`d in a shell also works here.
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

// A prompt that does not exist yet is the NORMAL case here — it is
// exactly what an unseeded project looks like — but the SDK logs every
// 404 as an error, with a stack trace and a full response dump, which
// on a first run buries the four lines that actually matter. The
// seeder reports its own outcome for every prompt, so the SDK's
// account is redundant rather than lost. The SDK reads this from the
// real process environment, not the object above. Set it yourself to
// get the SDK's logging back while debugging.
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
