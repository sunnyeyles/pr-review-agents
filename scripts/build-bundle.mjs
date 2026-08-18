/**
 * Bundles an app into a single self-contained ESM file for Node 22+.
 *
 * Run from an app directory via its `build` script: bundles src/index.ts
 * into dist/index.mjs, compiling workspace packages (consumed as
 * TypeScript source) into the bundle.
 *
 * Externals are per-target and passed on the command line:
 *
 *   node ../../scripts/build-bundle.mjs --external=@aws-sdk/*
 *     Lambda apps (apps/webhook, apps/worker). The nodejs22.x runtime
 *     provides the AWS SDK v3, so leaving it external keeps the zip
 *     small. Zipping happens in Terraform via the archive_file source.
 *
 *   node ../../scripts/build-bundle.mjs
 *     The GitHub Action (apps/action). Nothing is provided by the
 *     Actions node runtime, so everything is compiled in — the
 *     published action repository ships only action.yml and dist/.
 *
 * ESM/CJS interop: the bundle is ESM (matching "type": "module"
 * sources and the .mjs handler convention), but some transitive
 * dependencies are CJS. esbuild's CJS shim falls back to a `require`
 * binding when one is in scope, so the banner defines `require`,
 * `__filename`, and `__dirname` from import.meta — without it the
 * bundle can throw "Dynamic require of ... is not supported" at
 * runtime.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { build } from "esbuild";

const appDir = process.cwd();
const entryPoint = path.join(appDir, "src", "index.ts");
const outfile = path.join(appDir, "dist", "index.mjs");

const external = process.argv
  .filter((arg) => arg.startsWith("--external="))
  .map((arg) => arg.slice("--external=".length))
  .filter((value) => value.length > 0);

const banner = `import { createRequire as __banner_createRequire } from "node:module";
import { fileURLToPath as __banner_fileURLToPath } from "node:url";
import { dirname as __banner_dirname } from "node:path";
const require = __banner_createRequire(import.meta.url);
const __filename = __banner_fileURLToPath(import.meta.url);
const __dirname = __banner_dirname(__filename);
`;

await rm(path.join(appDir, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external,
  banner: { js: banner },
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
