/**
 * The read-only, repository-scoped tools a review agent gets; there is no write
 * tool here. Repository scope comes from the job, not the model.
 */
import type {
  ChangedFile,
  CodeSearchResult,
  GithubInstallationClient,
} from "@pr-review/github";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { ReviewContext } from "../agent-contract.js";
import { truncateWithMarker } from "./truncate.js";

/** Tool results larger than this are truncated to bound token usage. */
const MAX_TOOL_RESULT_CHARS = 50_000;

// Bounded by these, not by truncate(): truncation would cut the JSON mid-string.
const MAX_SEARCH_MATCHES = 20;

const MAX_SNIPPETS_PER_MATCH = 2;

const MAX_SNIPPET_CHARS = 400;

const TRUNCATION_MARKER = "\n[... truncated: result exceeded the size limit]";

function truncate(content: string): string {
  return truncateWithMarker(content, MAX_TOOL_RESULT_CHARS, TRUNCATION_MARKER);
}

/** Trimmed, deduplicated, and capped — the snippets the model actually sees. */
function boundSnippets(snippets: readonly string[]): string[] {
  return [...new Set(snippets.map((snippet) => snippet.trim()))]
    .filter((snippet) => snippet !== "")
    .slice(0, MAX_SNIPPETS_PER_MATCH)
    .map((snippet) => truncateWithMarker(snippet, MAX_SNIPPET_CHARS, "…"));
}

/** `searchedFor` is absent unless the caller derived the query it searched. */
function renderSearchResult(
  result: CodeSearchResult,
  searchedFor?: string,
): string {
  return JSON.stringify(
    {
      searchedFor,
      totalCount: result.totalCount,
      incompleteResults: result.incompleteResults,
      matches: result.matches.slice(0, MAX_SEARCH_MATCHES).map((match) => ({
        path: match.path,
        name: match.name,
        snippets: boundSnippets(match.snippets),
      })),
    },
    null,
    2,
  );
}

/** A repository-relative path: no absolute paths, no traversal, no dot segments. */
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.includes("\\") &&
      !path.startsWith("/") &&
      path
        .split("/")
        .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    {
      message:
        "path must be a repository-relative file path without traversal segments",
    },
  )
  .describe('Repository-relative file path, e.g. "src/index.ts".');

/** Scope qualifiers are rejected: the client adds the only repo: qualifier. */
const searchQuerySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((query) => !/\b(repo|org|user):/i.test(query), {
    message:
      "query must not contain repo:/org:/user: qualifiers; searches are always scoped to the pull request's repository",
  })
  .describe(
    'Search terms, e.g. "createSession". Do not include repo:/org:/user: qualifiers.',
  );

// Split by position: a file-name list must not judge a directory slot.
const GENERIC_FILE_STEMS = new Set(["index", "mod", "main", "__init__"]);

const GENERIC_DIRECTORIES = new Set([
  "src",
  "lib",
  "app",
  "pkg",
  "internal",
  "util",
  "utils",
  "common",
  "core",
  "components",
  "packages",
]);

/** A stem safe to quote into a query: no search operators, no qualifiers. */
const SEARCHABLE_STEM = /^[A-Za-z0-9._-]+$/;

function distinctive(name: string, generic: ReadonlySet<string>): boolean {
  return !generic.has(name.toLowerCase()) && SEARCHABLE_STEM.test(name);
}

/** Basename without its final extension, walking up when that stem is generic. */
function importerSearchStem(path: string): string {
  const directories = path.split("/");
  const file = directories.pop() ?? "";
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  if (distinctive(base, GENERIC_FILE_STEMS)) {
    return base;
  }
  const directory = directories
    .toReversed()
    .find((candidate) => distinctive(candidate, GENERIC_DIRECTORIES));
  if (directory !== undefined) {
    return directory;
  }
  throw new Error(
    `no distinctive name to search for in "${path}": every segment is a generic ` +
      "module name. Use search_repository with a symbol from the file instead.",
  );
}

// Each sampled commit costs its own API call, so this is the request budget.
const MAX_HISTORY_COMMITS = 10;

// A commit past this size is a sweep, not a related edit, so it is dropped.
const MAX_SWEEP_COMMIT_FILES = 40;

/** Co-changed files reported; the rows bound the payload, not `truncate`. */
const MAX_CO_CHANGED_FILES = 20;

/** Counts appearances per path across the commits, subject excluded. */
function tallyCoChanges(
  commits: readonly (readonly string[])[],
  subject: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const files of commits) {
    for (const file of new Set(files)) {
      if (file !== subject) {
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
    }
  }
  return counts;
}

const emptyInputSchema = z.strictObject({});

/** One changed file's patch; a file outside the PR, or without one, is an error. */
function patchFor(changedFiles: readonly ChangedFile[], path: string): string {
  const file = changedFiles.find((entry) => entry.filename === path);
  if (file === undefined) {
    throw new Error(`${path} is not a file this pull request changed`);
  }
  if (file.patch === undefined) {
    throw new Error(`${path} has no patch to show (for example, a binary file)`);
  }
  return file.patch;
}

/** Exactly the eight read-only tools, bound to one pull request. */
export function createReviewTools(
  github: GithubInstallationClient,
  context: ReviewContext,
): ToolSet {
  const { owner, repo } = context;
  // Commits are immutable, so one fetch per SHA serves every call this run.
  const commitFiles = new Map<string, Promise<string[]>>();
  const filesOf = (sha: string): Promise<string[]> => {
    let files = commitFiles.get(sha);
    if (files === undefined) {
      files = github.listCommitFiles({ owner, repo, sha });
      commitFiles.set(sha, files);
    }
    return files;
  };

  return {
    get_pull_request: tool({
      description:
        "Get the pull request's title, description, author, branches, and commit SHAs as JSON.",
      inputSchema: emptyInputSchema,
      async execute() {
        return truncate(JSON.stringify(context.pullRequest, null, 2));
      },
    }),
    list_changed_files: tool({
      description:
        "List the files changed by the pull request (filename, status, additions, deletions) as JSON.",
      inputSchema: emptyInputSchema,
      async execute() {
        const listed = context.changedFiles.map(
          ({ filename, status, additions, deletions }) => ({
            filename,
            status,
            additions,
            deletions,
          }),
        );
        return truncate(JSON.stringify(listed, null, 2));
      },
    }),
    get_diff: tool({
      description:
        "Get one changed file's whole patch by path, or the full unified diff with no path. " +
        "Prefer a path: the full diff was truncated in the opening message only if it is long, " +
        "and a single patch is never cut short.",
      inputSchema: z.strictObject({
        path: repositoryPathSchema
          .optional()
          .describe("A changed file's path for its patch alone; omit for the whole diff."),
      }),
      async execute({ path }) {
        return truncate(
          path === undefined ? context.diff : patchFor(context.changedFiles, path),
        );
      },
    }),
    get_file: tool({
      description:
        "Read one file's contents at the pull request's HEAD commit (the proposed state). " +
        'The path is relative to the repository root, e.g. "src/index.ts".',
      inputSchema: z.strictObject({ path: repositoryPathSchema }),
      async execute({ path }) {
        return truncate(
          await github.getFileContents({
            owner,
            repo,
            path,
            ref: context.pullRequest.headSha,
          }),
        );
      },
    }),
    get_base_file: tool({
      description:
        "Read one file's contents at the pull request's BASE commit (the state before this PR). " +
        'The path is relative to the repository root, e.g. "src/index.ts".',
      inputSchema: z.strictObject({ path: repositoryPathSchema }),
      async execute({ path }) {
        return truncate(
          await github.getFileContents({
            owner,
            repo,
            path,
            ref: context.pullRequest.baseSha,
          }),
        );
      },
    }),
    search_repository: tool({
      description:
        "Search code within the pull request's repository. Returns matching files with short " +
        "snippets of the matching code, and totalCount, the number of matches in the whole " +
        "repository — far more than the page returned means the query was not selective enough. " +
        "The search is always scoped to this repository; scope qualifiers are not allowed.",
      inputSchema: z.strictObject({ query: searchQuerySchema }),
      async execute({ query }) {
        const result = await github.searchCode({ owner, repo, query });
        return renderSearchResult(result);
      },
    }),
    find_importers: tool({
      description:
        "Find files that MENTION this file's name — a cheap proxy for \"what imports it\", NOT a " +
        "resolved import graph. It is a text search for the file's name stem (returned as " +
        "searchedFor), so it includes unrelated files using the same word and MISSES importers " +
        "that alias the path or import the directory. An empty result means the search found " +
        "nothing — never that nothing imports the file.",
      inputSchema: z.strictObject({ path: repositoryPathSchema }),
      async execute({ path }) {
        const stem = importerSearchStem(path);
        const result = await github.searchCode({ owner, repo, query: `"${stem}"` });
        const subject = path.toLowerCase();
        return renderSearchResult(
          {
            ...result,
            matches: result.matches.filter(
              (match) => match.path.toLowerCase() !== subject,
            ),
          },
          stem,
        );
      },
    }),
    find_co_changed_files: tool({
      description:
        "Find files that were edited in the same commits as this file. This is CORRELATION, not " +
        "a dependency: files co-change because one commit did two unrelated things as often as " +
        "because they belong together, and related files never edited together do not appear. " +
        `It samples the ${MAX_HISTORY_COMMITS} most recent commits touching the path, ignores ` +
        `sweeps that touched more than ${MAX_SWEEP_COMMIT_FILES} files, and reports at most ` +
        `${MAX_CO_CHANGED_FILES} files. Each commits count is out of commitsExamined; a file in ` +
        "only one of them is noise. A file this pull request adds has no history yet.",
      inputSchema: z.strictObject({ path: repositoryPathSchema }),
      async execute({ path }) {
        const shas = await github.listCommitShas({
          owner,
          repo,
          path,
          limit: MAX_HISTORY_COMMITS,
        });
        const commits = await Promise.all(shas.map(filesOf));
        const examined = commits.filter(
          (files) => files.length <= MAX_SWEEP_COMMIT_FILES,
        );
        const coChanged = [...tallyCoChanges(examined, path)]
          // Ties break on path so the same history always renders the same.
          .sort(([pathA, a], [pathB, b]) =>
            a === b ? pathA.localeCompare(pathB) : b - a,
          )
          .slice(0, MAX_CO_CHANGED_FILES)
          .map(([file, commitCount]) => ({ path: file, commits: commitCount }));
        return JSON.stringify(
          {
            path,
            commitsExamined: examined.length,
            commitsSkippedAsSweeps: commits.length - examined.length,
            coChanged,
          },
          null,
          2,
        );
      },
    }),
  };
}
