/**
 * The one esbuild configuration this repository bundles with; `pnpm build` and
 * `pnpm seed-prompts` must not disagree. Nothing is externalised.
 */
import { build } from "esbuild";

/**
 * ESM output over CJS dependencies: esbuild's shim needs `require`,
 * `__filename` and `__dirname` in scope or the bundle throws at runtime.
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
