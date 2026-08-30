/**
 * Loads one evaluation fixture: `repo/` is the tree at the head SHA and
 * `base/` holds the previous contents of the modified files. Everything
 * the pipeline sees is derived from those two trees.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReviewContext } from "@pr-review/ai";
import type { ChangedFile, PullRequestDetails } from "@pr-review/github";
import { z } from "zod";

import { buildFileDiff, buildPatch } from "./unified-diff.js";

/** The directory holding every fixture, one subdirectory each. */
export const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

const manifestSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  baseSha: shaSchema,
  headSha: shaSchema,
  pullRequest: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string(),
    author: z.string().min(1),
    baseRef: z.string().min(1),
    headRef: z.string().min(1),
  }),
  changedFiles: z
    .array(
      z.object({
        path: z.string().min(1),
        status: z.enum(["added", "modified"]),
      }),
    )
    .min(1),
});

export type FixtureManifest = z.infer<typeof manifestSchema>;

/** A fixture repository loaded into everything the pipeline consumes. */
export interface LoadedFixture {
  name: string;
  /** Human-readable fixture name, used in the evaluation report. */
  title: string;
  manifest: FixtureManifest;
  pullRequest: PullRequestDetails;
  changedFiles: ChangedFile[];
  /** The pull request's full unified diff. */
  diff: string;
  /** The context the review pipeline runs against. */
  context: ReviewContext;
  /** Every file in the repository at the head SHA, by path. */
  headFiles: ReadonlyMap<string, string>;
  /** Every file that existed at the base SHA, by path. */
  baseFiles: ReadonlyMap<string, string>;
}

/** Every fixture directory name, in alphabetical order. */
export function listFixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Reads a whole file tree into a path -> contents map, recursively. */
function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.set(relative(root, full).split(sep).join(posix.sep), readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  return files;
}

function required(files: ReadonlyMap<string, string>, path: string, tree: string): string {
  const contents = files.get(path);
  if (contents === undefined) {
    throw new Error(`fixture file ${path} is missing from the ${tree} tree`);
  }
  return contents;
}

/** Synchronous on purpose: the evaluation names its cases at module scope. */
export function loadFixture(name: string): LoadedFixture {
  const dir = join(FIXTURES_DIR, name);
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")),
  );
  if (manifest.name !== name) {
    throw new Error(
      `fixture ${name} declares the name ${manifest.name}; the manifest name must match its directory`,
    );
  }

  const headFiles = readTree(join(dir, "repo"));
  const changedPaths = new Set(manifest.changedFiles.map((file) => file.path));
  const modifiedPaths = new Set(
    manifest.changedFiles
      .filter((file) => file.status === "modified")
      .map((file) => file.path),
  );

  // Unchanged files match the head tree, modified ones come from base/,
  // and added files are absent.
  const baseOverrides = modifiedPaths.size === 0 ? new Map<string, string>() : readTree(join(dir, "base"));
  for (const path of baseOverrides.keys()) {
    if (!modifiedPaths.has(path)) {
      throw new Error(
        `fixture ${name} has base/${path}, but ${path} is not listed as a modified file`,
      );
    }
  }
  const baseFiles = new Map<string, string>();
  for (const [path, contents] of headFiles) {
    if (!changedPaths.has(path)) {
      baseFiles.set(path, contents);
    }
  }
  for (const path of modifiedPaths) {
    baseFiles.set(path, required(baseOverrides, path, "base"));
  }

  const changedFiles: ChangedFile[] = manifest.changedFiles.map((file) => {
    const headText = required(headFiles, file.path, "repo");
    const baseText = file.status === "added" ? undefined : baseFiles.get(file.path);
    const patch = buildPatch(baseText, headText, file.path);
    const additions = patch
      .split("\n")
      .filter((line) => line.startsWith("+")).length;
    const deletions = patch
      .split("\n")
      .filter((line) => line.startsWith("-")).length;
    return { filename: file.path, status: file.status, additions, deletions, patch };
  });

  const diff = manifest.changedFiles
    .map((file) =>
      buildFileDiff(
        file.path,
        file.status === "added" ? undefined : baseFiles.get(file.path),
        required(headFiles, file.path, "repo"),
      ),
    )
    .join("\n");

  const pullRequest: PullRequestDetails = {
    number: manifest.pullRequest.number,
    title: manifest.pullRequest.title,
    body: manifest.pullRequest.body,
    author: manifest.pullRequest.author,
    baseRef: manifest.pullRequest.baseRef,
    baseSha: manifest.baseSha,
    headRef: manifest.pullRequest.headRef,
    headSha: manifest.headSha,
  };

  return {
    name,
    title: manifest.title,
    manifest,
    pullRequest,
    changedFiles,
    diff,
    context: {
      owner: manifest.owner,
      repo: manifest.repo,
      pullRequest,
      changedFiles,
      diff,
    },
    headFiles,
    baseFiles,
  };
}
