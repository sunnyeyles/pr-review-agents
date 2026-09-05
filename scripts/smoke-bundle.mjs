/**
 * Smoke-tests apps/action/dist/index.mjs, which tsc and vitest never read: it
 * must import cleanly on action.yml's Node major and be inert without CI env.
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
 * An export the bundle must expose, so a bundle that silently compiled to
 * nothing fails too. Rename here if src/index.ts renames it.
 */
const requiredExport = "runEntrypoint";

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
 * Imports the bundle in a child process. Findings go to a file, not stdout, so
 * the inert run's "not one byte" check holds. Never calls process.exit().
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
