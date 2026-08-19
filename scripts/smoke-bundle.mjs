/**
 * Smoke-tests the built action bundle (apps/action/dist/index.mjs).
 *
 * The bundle is the only artefact consumers execute, and it is produced
 * by a step nothing else exercises: esbuild rewrites the whole workspace
 * into one file, so a dependency that will not bundle, or an import that
 * the Actions Node runtime rejects, is invisible to `tsc` and to vitest —
 * both of which read the TypeScript sources, never the bundle. This check
 * runs the artefact itself, and asserts the two properties the release
 * depends on:
 *
 *   1. It imports cleanly under the Node major the action declares in
 *      action.yml (`runs.using: node<major>`).
 *   2. It performs no work when the GITHUB_ACTIONS environment marker is
 *      absent — the contract src/index.ts's entrypoint guard promises, and
 *      what makes the module safe to import from tests and from here.
 *
 * Inertness is proved by a pair of runs rather than a single one, because
 * "printed nothing" is also what a broken-and-silent bundle would do:
 *
 *   inert run  — marker absent: must exit 0 with empty stdout and stderr,
 *                and must still expose its public exports, so we know the
 *                module graph really loaded.
 *   armed run  — marker present and nothing else: main() must run and fail
 *                fast on the missing GITHUB_EVENT_PATH, logging
 *                review.failed and exiting non-zero.
 *
 * The armed run reaches no network and touches no repository: main()'s
 * first act is the GITHUB_EVENT_PATH check. Together the two runs show the
 * guard is load-bearing — the difference in behaviour comes from the marker
 * and nothing else.
 *
 * Usage: node scripts/smoke-bundle.mjs   (after building the bundle)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actionDir = path.join(repoRoot, "apps", "action");
const bundlePath = path.join(actionDir, "dist", "index.mjs");
const actionManifest = path.join(actionDir, "action.yml");

/**
 * An export the bundle must expose. Importing a module that throws is an
 * obvious failure; importing one that silently bundled to nothing is not,
 * so we look for something real on the namespace. If this export is ever
 * renamed on purpose, rename it here too.
 */
const requiredExport = "createActionHandler";

const failures = [];

function fail(message) {
  failures.push(message);
}

function heading(message) {
  console.log(`\n${message}`);
}

/** Env keys the runner injects that would confuse either run. */
function scrubbedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(GITHUB_|INPUT_|ACTIONS_|RUNNER_)/.test(key)) continue;
    if (key === "CI") continue;
    env[key] = value;
  }
  return env;
}

/**
 * Imports the bundle in a child process and reports what it saw. The probe
 * writes its findings to a file rather than stdout, so the parent can hold
 * the child's stdout and stderr to the "not one byte" standard the inert
 * run requires. It never calls process.exit(), so an exit code set by the
 * bundle's own top-level catch survives.
 */
const probeSource = `
import { writeFileSync } from "node:fs";
import process from "node:process";

const [bundlePath, resultPath] = process.argv.slice(2);
const result = { imported: false, exports: [], error: null };
try {
  const namespace = await import(bundlePath);
  result.imported = true;
  result.exports = Object.keys(namespace).sort();
} catch (error) {
  result.error = error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error);
}
writeFileSync(resultPath, JSON.stringify(result));
`;

const workDir = mkdtempSync(path.join(tmpdir(), "pr-review-smoke-"));
const probePath = path.join(workDir, "probe.mjs");
writeFileSync(probePath, probeSource);

function runProbe(label, extraEnv) {
  const resultPath = path.join(workDir, `${label}.json`);
  const child = spawnSync(
    process.execPath,
    [probePath, bundlePath, resultPath],
    {
      cwd: workDir,
      env: { ...scrubbedEnv(), ...extraEnv },
      encoding: "utf8",
    },
  );
  let result = null;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    result = null;
  }
  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    result,
  };
}

try {
  // --- the bundle exists at all ------------------------------------------
  try {
    readFileSync(bundlePath);
  } catch {
    console.error(
      `Bundle not found at ${path.relative(repoRoot, bundlePath)}.\n` +
        "Build it first: pnpm --filter @pr-review/action build",
    );
    process.exit(1);
  }

  // --- Node major matches what the action declares ------------------------
  heading("Node runtime");
  const manifest = readFileSync(actionManifest, "utf8");
  const declared = /^\s*using:\s*['"]?node(\d+)['"]?\s*$/m.exec(manifest);
  if (declared === null) {
    fail(`Could not read "runs.using: node<major>" from ${actionManifest}`);
  } else {
    const targetMajor = Number(declared[1]);
    const actualMajor = Number(process.versions.node.split(".")[0]);
    console.log(
      `  action.yml declares node${targetMajor}; running under node ${process.versions.node}`,
    );
    if (actualMajor < targetMajor) {
      fail(
        `Smoke check must run under Node ${targetMajor} or newer (the action's runtime); ` +
          `this is Node ${process.versions.node}.`,
      );
    }
  }

  // --- inert run: marker absent ------------------------------------------
  heading("Inert run (GITHUB_ACTIONS unset)");
  const inert = runProbe("inert", {});
  if (inert.result === null) {
    fail("Inert run: the probe produced no result — the child process died.");
  } else if (!inert.result.imported) {
    fail(`Inert run: importing the bundle threw — ${inert.result.error}`);
  } else if (!inert.result.exports.includes(requiredExport)) {
    fail(
      `Inert run: the bundle imported but does not export ${requiredExport} ` +
        `(saw: ${inert.result.exports.join(", ") || "nothing"}). ` +
        "If that export was renamed on purpose, update requiredExport in this script.",
    );
  } else {
    console.log(`  imported cleanly; ${inert.result.exports.length} exports`);
  }
  if (inert.status !== 0) {
    fail(`Inert run: expected exit code 0, got ${inert.status}.`);
  }
  if (inert.stdout !== "") {
    fail(`Inert run: expected no stdout, got:\n${inert.stdout}`);
  }
  if (inert.stderr !== "") {
    fail(`Inert run: expected no stderr, got:\n${inert.stderr}`);
  }
  if (inert.status === 0 && inert.stdout === "" && inert.stderr === "") {
    console.log("  performed no work: exit 0, no stdout, no stderr");
  }

  // --- armed run: marker present, nothing else ----------------------------
  heading("Armed run (GITHUB_ACTIONS=true, no event payload)");
  const armed = runProbe("armed", { GITHUB_ACTIONS: "true" });
  const ranAndFailed =
    armed.status !== 0 && armed.stderr.includes("review.failed");
  if (!ranAndFailed) {
    fail(
      "Armed run: setting GITHUB_ACTIONS=true did not start the entrypoint. " +
        "Expected a non-zero exit and a review.failed log for the missing " +
        `GITHUB_EVENT_PATH; got exit ${armed.status} with stderr:\n${armed.stderr}`,
    );
  } else {
    console.log(
      `  entrypoint ran and failed fast as expected (exit ${armed.status}, review.failed logged)`,
    );
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("\nBundle smoke check FAILED:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("\nBundle smoke check passed.");
