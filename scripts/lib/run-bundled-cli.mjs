/**
 * Bundles one of the workspace CLIs to a temp file and runs it. scripts/ is
 * not a workspace project and .npmrc pins node-linker=isolated, so nothing
 * here can resolve @pr-review/* — and the workspace sources import each
 * other with `.js` specifiers that resolve to `.ts`, which only a bundler
 * rewrites. The bundle is temporary because it is a means of running the
 * command once, not something anyone ships.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bundle } from "./bundle.mjs";
import { readEnvFile } from "./env-file.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * @param {object} options
 * @param {string} options.entry Repo-relative path to the CLI's entry point.
 * @param {string} options.prefix Temp-directory prefix for the bundle.
 * @param {(cli: Record<string, any>) => Record<string, unknown>} options.createEnvironment
 */
export async function runBundledCli({ entry, prefix, createEnvironment }) {
  // The real environment wins over the file, so a one-off VAR=… on the
  // command line, and Actions secrets, are used as-is.
  const env = {
    ...readEnvFile(path.join(repoRoot, ".env.local")),
    ...process.env,
  };

  // The SDK logs an expected 404 as an error with a full response dump,
  // which buries the lines that matter; each CLI reports its own outcome.
  // Set it yourself to get the SDK's logging back while debugging.
  process.env["LANGFUSE_LOG_LEVEL"] ??= "NONE";

  const work = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    const outfile = path.join(work, "cli.mjs");
    await bundle({
      entryPoint: path.join(repoRoot, entry),
      outfile,
      logLevel: "warning",
    });

    const cli = await import(pathToFileURL(outfile).href);
    // The CLI owns its own SDK client, logger, and output stream; this
    // script owns only where credentials came from.
    const { env: _processEnv, ...rest } = createEnvironment(cli);
    process.exitCode = await cli.main(process.argv.slice(2), { env, ...rest });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
