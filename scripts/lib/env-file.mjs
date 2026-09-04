/**
 * Reads .env.local into a plain object. It is gitignored and holds
 * local credentials — the README already points people there — and a
 * dotenv dependency for one file of `KEY=value` lines is not worth it.
 *
 * Quotes are stripped and `export ` prefixes tolerated, so a file that
 * can be `source`d in a shell also works here.
 */
import { readFileSync } from "node:fs";

export function readEnvFile(file) {
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
