/**
 * The read-only, repository-scoped tools a review agent gets; there is no write
 * tool here. Repository scope comes from the job, not the model.
 */
import type {
  CodeSearchResult,
  GithubInstallationClient,
} from "@pr-review/github";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { truncateWithMarker } from "./truncate.js";

/** The repository/PR coordinates a job pins its tools to. */
export interface ReviewToolScope {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
}

/** Tool results larger than this are truncated to bound token usage. */
const MAX_TOOL_RESULT_CHARS = 50_000;

// Bounded by these, not by truncate(): truncation would cut the JSON mid-string.
const MAX_SNIPPETS_PER_MATCH = 2;

const MAX_SNIPPET_CHARS = 400;

const TRUNCATION_MARKER = "\n[... truncated: result exceeded the size limit]";

const SNIPPET_TRUNCATION_MARKER = "…";

function truncate(content: string): string {
  return truncateWithMarker(content, MAX_TOOL_RESULT_CHARS, TRUNCATION_MARKER);
}

/** Trimmed, deduplicated, and capped — the snippets the model actually sees. */
function boundSnippets(snippets: readonly string[]): string[] {
  const distinct = [...new Set(snippets.map((snippet) => snippet.trim()))];
  return distinct
    .filter((snippet) => snippet !== "")
    .slice(0, MAX_SNIPPETS_PER_MATCH)
    .map((snippet) =>
      snippet.length <= MAX_SNIPPET_CHARS
        ? snippet
        : snippet.slice(0, MAX_SNIPPET_CHARS) + SNIPPET_TRUNCATION_MARKER,
    );
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
      matches: result.matches.map((match) => ({
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

/** Basename without its final extension, walking up when that stem is generic. */
function importerSearchStem(path: string): string {
  const directories = path.split("/");
  const file = directories.pop() ?? "";
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  const candidates: [string, ReadonlySet<string>][] = [
    [base, GENERIC_FILE_STEMS],
    ...directories
      .toReversed()
      .map((directory): [string, ReadonlySet<string>] => [
        directory,
        GENERIC_DIRECTORIES,
      ]),
  ];
  for (const [candidate, generic] of candidates) {
    if (!generic.has(candidate.toLowerCase()) && SEARCHABLE_STEM.test(candidate)) {
      return candidate;
    }
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

/** Counts appearances per path across the examined commits, subject excluded. */
function tallyCoChanges(
  commits: readonly (readonly string[])[],
  subject: string,
): { counts: Map<string, number>; skipped: number } {
  const counts = new Map<string, number>();
  let skipped = 0;
  for (const files of commits) {
    if (files.length > MAX_SWEEP_COMMIT_FILES) {
      skipped += 1;
      continue;
    }
    for (const file of new Set(files)) {
      if (file !== subject) {
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
    }
  }
  return { counts, skipped };
}

const emptyInputSchema = z.strictObject({});

function pullRef(scope: ReviewToolScope) {
  return {
    owner: scope.owner,
    repo: scope.repo,
    pullRequestNumber: scope.pullRequestNumber,
  };
}

/** Exactly the eight read-only tools, bound to one pull request. */
export function createReviewTools(
  github: GithubInstallationClient,
  scope: ReviewToolScope,
): ToolSet {
  return {
    get_pull_request: tool({
      description:
        "Get the pull request's title, description, author, branches, and commit SHAs as JSON.",
      inputSchema: emptyInputSchema,
      async execute() {
        const pullRequest = await github.getPullRequest(pullRef(scope));
        return truncate(JSON.stringify(pullRequest, null, 2));
      },
    }),
    list_changed_files: tool({
      description:
        "List the files changed by the pull request (filename, status, additions, deletions) as JSON.",
      inputSchema: emptyInputSchema,
      async execute() {
        const files = await github.listChangedFiles(pullRef(scope));
        const listed = files.map(({ filename, status, additions, deletions }) => ({
          filename,
          status,
          additions,
          deletions,
        }));
        return truncate(JSON.stringify(listed, null, 2));
      },
    }),
    get_diff: tool({
      description: "Get the pull request's full unified diff.",
      inputSchema: emptyInputSchema,
      async execute() {
        return truncate(await github.getDiff(pullRef(scope)));
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
            owner: scope.owner,
            repo: scope.repo,
            path,
            ref: scope.headSha,
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
            owner: scope.owner,
            repo: scope.repo,
            path,
            ref: scope.baseSha,
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
        const result = await github.searchCode({
          owner: scope.owner,
          repo: scope.repo,
          query,
        });
        return renderSearchResult(result);
      },
    }),
    find_importers: tool({
      description:
        "Find files that MENTION this file's name — a cheap proxy for \"what imports it\", NOT a " +
        "resolved import graph. It is a text search for the file's name stem, so results routinely " +
        "include unrelated files using the same word, and MISS importers that alias the path or " +
        "import the directory. The stem actually searched comes back as searchedFor, and a high " +
        "totalCount means that stem was too common to be meaningful. An empty result means the " +
        "search found nothing — never that nothing imports the file.",
      inputSchema: z.strictObject({ path: repositoryPathSchema }),
      async execute({ path }) {
        const stem = importerSearchStem(path);
        const result = await github.searchCode({
          owner: scope.owner,
          repo: scope.repo,
          query: `"${stem}"`,
        });
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
        "Find files that were edited in the same commits as this file, from the DEFAULT branch's " +
        "history. This is CORRELATION, not a dependency: files co-change because one commit did " +
        "two unrelated things as often as because they belong together, and genuinely related " +
        "files that were never edited together do not appear at all. It samples the " +
        `${MAX_HISTORY_COMMITS} most recent commits touching the path and ignores any that ` +
        `touched more than ${MAX_SWEEP_COMMIT_FILES} files, since those are sweeps, and reports at ` +
        `most ${MAX_CO_CHANGED_FILES} files. Each result's commits count is out of commitsExamined; ` +
        "a file in only one of them is noise. An empty result means the path has no history on the " +
        "default branch, which is always true of a file this pull request adds.",
      inputSchema: z.strictObject({ path: repositoryPathSchema }),
      async execute({ path }) {
        const shas = await github.listCommitShas({
          owner: scope.owner,
          repo: scope.repo,
          path,
          limit: MAX_HISTORY_COMMITS,
        });
        const commits = await Promise.all(
          shas.map((sha) =>
            github.listCommitFiles({
              owner: scope.owner,
              repo: scope.repo,
              sha,
            }),
          ),
        );
        const { counts, skipped } = tallyCoChanges(commits, path);
        const coChanged = [...counts]
          // Ties break on path so the same history always renders the same.
          .sort(([pathA, a], [pathB, b]) =>
            a === b ? pathA.localeCompare(pathB) : b - a,
          )
          .slice(0, MAX_CO_CHANGED_FILES)
          .map(([file, commitCount]) => ({ path: file, commits: commitCount }));
        return JSON.stringify(
          {
            path,
            commitsExamined: commits.length - skipped,
            commitsSkippedAsSweeps: skipped,
            coChanged,
          },
          null,
          2,
        );
      },
    }),
  };
}
