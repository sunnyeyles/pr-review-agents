/**
 * The lens set a run works with, read from repository configuration.
 * There is no built-in set: the agents a review runs are exactly the
 * ones configured, so nothing in the system may assume which lenses, or
 * how many, exist.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { reviewLensSchema, type ReviewLens } from "./agents/lens.js";

/** Where the lens configuration is read from unless a path is given. */
export const DEFAULT_LENS_CONFIG_PATH = ".github/pr-review.yml";

/** Raised for configuration that is missing, malformed, or empty. */
export class LensConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LensConfigError";
  }
}

const lensConfigSchema = z
  .object({
    lenses: z.array(reviewLensSchema).min(1),
  })
  .strict();

export type LensConfig = z.infer<typeof lensConfigSchema>;

/** Parses and validates a config document into the lenses it defines. */
export function parseLensConfig(source: string, path: string): LensConfig {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error: unknown) {
    throw new LensConfigError(
      `${path} is not valid YAML: ${(error as Error).message}`,
    );
  }

  const parsed = lensConfigSchema.safeParse(document ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new LensConfigError(`${path} is invalid — ${problems}`);
  }

  const seen = new Set<string>();
  for (const lens of parsed.data.lenses) {
    if (seen.has(lens.category)) {
      throw new LensConfigError(
        `${path} defines the review agent "${lens.category}" twice`,
      );
    }
    seen.add(lens.category);
  }
  return parsed.data;
}

/** Reads a file, or resolves undefined when it does not exist. */
export type ReadOptionalFile = (path: string) => Promise<string | undefined>;

export interface LoadLensSetOptions {
  readFile: ReadOptionalFile;
  /** Defaults to DEFAULT_LENS_CONFIG_PATH. */
  path?: string | undefined;
}

/** The message shown when no configuration is found. */
export function missingConfigMessage(path: string): string {
  return [
    `No review agents are configured: ${path} does not exist.`,
    "",
    "This action ships no agents of its own — it reviews with exactly the",
    "ones you define. Create the file with at least one agent:",
    "",
    "  lenses:",
    "    - category: correctness",
    "      role: Correctness reviewer",
    "      focus: |",
    "        Review the pull request ONLY for correctness problems:",
    "        - bugs and incorrect logic",
    "        - missing validation",
    "        Do NOT report style or architectural opinions.",
    "",
    "The action reads this from the checked-out workspace, so the job needs",
    "an actions/checkout step. See the README for a fuller starting point.",
  ].join("\n");
}

/**
 * The lens set for one run. A missing or unusable config fails loudly:
 * a review that ran the wrong agents — or none — looks exactly like a
 * clean bill of health.
 */
export async function loadLensSet(
  options: LoadLensSetOptions,
): Promise<ReviewLens[]> {
  const path = options.path ?? DEFAULT_LENS_CONFIG_PATH;

  const source = await options.readFile(path);
  if (source === undefined) {
    throw new LensConfigError(missingConfigMessage(path));
  }
  return [...parseLensConfig(source, path).lenses];
}
