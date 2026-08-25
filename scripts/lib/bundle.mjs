/**
 * The one esbuild configuration this repository bundles with.
 *
 * Two commands need it and must not disagree: `pnpm build` produces
 * the action's committed dist/index.mjs, and `pnpm seed-prompts`
 * bundles the seeder to a temporary file so it can import workspace
 * packages at all. A bundle that ran the seeder differently from the
 * action would test something other than what ships.
 *
 * Nothing is externalised, because nothing is provided by the Actions
 * node runtime — the published action repository ships only action.yml
 * and dist/.
 */
import { build } from "esbuild";

/**
 * ESM/CJS interop. The output is ESM (matching "type": "module"
 * sources and the .mjs handler convention), but some transitive
 * dependencies are CJS. esbuild's CJS shim falls back to a `require`
 * binding when one is in scope, so this defines `require`,
 * `__filename`, and `__dirname` from import.meta — without it the
 * bundle can throw "Dynamic require of ... is not supported" at
 * runtime.
 */
const BANNER = `import { createRequire as __banner_createRequire } from "node:module";
import { fileURLToPath as __banner_fileURLToPath } from "node:url";
import { dirname as __banner_dirname } from "node:path";
const require = __banner_createRequire(import.meta.url);
const __filename = __banner_fileURLToPath(import.meta.url);
const __dirname = __banner_dirname(__filename);
`;

/** Bundles one TypeScript entry point into a self-contained ESM file. */
export function bundle({ entryPoint, outfile, logLevel = "info" }) {
  return build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: BANNER },
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel,
  });
}
