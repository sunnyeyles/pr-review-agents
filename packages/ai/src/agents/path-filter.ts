/**
 * An agent's `paths`: the changed files that wake it. Matching is POSIX
 * only, because the GitHub API always spells a filename with forward
 * slashes and the host platform must not change which agents run.
 */
import picomatch from "picomatch";
import { z } from "zod";

/** picomatch 4 accepts `windows`; @types/picomatch 4.0.3 omits it. */
type MatchOptions = NonNullable<Parameters<typeof picomatch>[1]> & {
  windows?: boolean;
};

/**
 * Dotfiles match, so a `.github` pattern reads the way it is written.
 * `windows: false` pins the separator: picomatch otherwise defaults to
 * the host platform, and these filenames come from the GitHub API.
 */
const MATCH_OPTIONS: MatchOptions = { dot: true, windows: false };

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

export interface CompiledPathFilter {
  matches(filename: string): boolean;
}

/**
 * Compiles the positive and `!`-negated patterns separately so negation
 * subtracts. picomatch's own array form ORs every pattern, which would
 * let a test file through a positive pattern that a negation excludes.
 */
export function compilePathFilter(
  patterns: readonly string[],
): CompiledPathFilter {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      excluded.push(pattern.slice(1));
    } else {
      included.push(pattern);
    }
  }

  if (included.length === 0) {
    return { matches: () => false };
  }
  const isIncluded = picomatch(included, MATCH_OPTIONS);
  const isExcluded =
    excluded.length === 0 ? undefined : picomatch(excluded, MATCH_OPTIONS);
  return {
    matches: (filename) =>
      isIncluded(filename) && isExcluded?.(filename) !== true,
  };
}
