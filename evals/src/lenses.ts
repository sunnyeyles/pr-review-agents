/**
 * The lens set the evals run: this repository's own configuration, the
 * same file the action reads. Nothing ships a default set, so an eval
 * has to name where its agents come from.
 */
import { readFileSync } from "node:fs";

import { parseLensConfig, type ReviewLens } from "@pr-review/ai";

const CONFIG_PATH = ".github/pr-review.yml";

export function repositoryLenses(): ReviewLens[] {
  const path = new URL(`../../${CONFIG_PATH}`, import.meta.url);
  return [...parseLensConfig(readFileSync(path, "utf8"), CONFIG_PATH).lenses];
}
