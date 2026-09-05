/**
 * Bundles src/index.ts into dist/index.mjs, a self-contained ESM file for Node
 * 22+. Run from an app directory via its `build` script.
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
