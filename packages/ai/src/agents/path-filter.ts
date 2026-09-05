/**
 * An agent's `paths`: the changed files that wake it. POSIX-only matching,
 * since the GitHub API always uses forward slashes.
 */
import picomatch, { type PicomatchOptions } from "picomatch";
import { z } from "zod";

/**
 * `windows: false` pins the separator, which picomatch otherwise takes
 * from the host platform. picomatch 4 accepts it; its types do not.
 */
const MATCH_OPTIONS: PicomatchOptions & { windows?: boolean } = {
  dot: true,
  windows: false,
};

/** Rejects a pattern that could never match a changed file. */
function patternIssue(pattern: string): string | undefined {
  const glob = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  if (glob === "") {
    return `"${pattern}" negates nothing`;
  }
  if (glob.includes("\\")) {
    return `"${pattern}" uses a backslash; paths are POSIX, e.g. packages/github/**`;
  }
  if (glob.startsWith("/") || glob.startsWith("./") || glob.startsWith("../")) {
    return `"${pattern}" is not repository-relative, e.g. packages/github/**`;
  }
  return undefined;
}

/**
 * An agent's path patterns. A list of nothing but negations would match
 * no file and retire the agent in silence, so it is rejected here.
 */
export const agentPathsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .superRefine((patterns, ctx) => {
    for (const [index, pattern] of patterns.entries()) {
      const issue = patternIssue(pattern);
      if (issue !== undefined) {
        ctx.addIssue({ code: "custom", message: issue, path: [index] });
      }
    }
    if (patterns.every((pattern) => pattern.startsWith("!"))) {
      ctx.addIssue({
        code: "custom",
        message: "needs at least one pattern that is not a negation",
      });
    }
  });

/** True for a changed file the agent declaring these patterns cares about. */
export type PathFilter = (filename: string) => boolean;

/**
 * Positive and `!`-negated patterns compile separately so negation subtracts.
 * picomatch's array form ORs them, letting an excluded file through.
 */
export function compilePathFilter(patterns: readonly string[]): PathFilter {
  const included = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excluded = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));

  if (included.length === 0) {
    return () => false;
  }
  // Wrapped, not bare: with a second argument set, picomatch returns a truthy
  // state object on a non-match, and an array callback supplies the index.
  const isIncluded = picomatch(included, MATCH_OPTIONS);
  if (excluded.length === 0) {
    return (filename) => isIncluded(filename);
  }
  const isExcluded = picomatch(excluded, MATCH_OPTIONS);
  return (filename) => isIncluded(filename) && !isExcluded(filename);
}
