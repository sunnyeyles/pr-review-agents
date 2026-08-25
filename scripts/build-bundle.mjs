/**
 * Bundles an app into a single self-contained ESM file for Node 22+.
 *
 * Run from an app directory via its `build` script: bundles src/index.ts
 * into dist/index.mjs, compiling workspace packages (consumed as
 * TypeScript source) into the bundle.
 *
 * apps/action is the only consumer today: `node ../../scripts/build-bundle.mjs`.
 *
 * The esbuild settings themselves live in scripts/lib/bundle.mjs,
 * shared with the prompt seeder.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { bundle } from "./lib/bundle.mjs";

const appDir = process.cwd();

await rm(path.join(appDir, "dist"), { recursive: true, force: true });

await bundle({
  entryPoint: path.join(appDir, "src", "index.ts"),
  outfile: path.join(appDir, "dist", "index.mjs"),
});
