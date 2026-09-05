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

// Capped before serialisation, never by truncate(): truncation cuts JSON mid-string.
const MAX_SNIPPETS_PER_MATCH = 2;

const MAX_SNIPPET_CHARS = 400;

const TRUNCATION_MARKER = "\n[... truncated: result exceeded the size limit]";

const SNIPPET_TRUNCATION_MARKER = "…";

function truncate(content: string): string {
  return truncateWithMarker(content, MAX_TOOL_RESULT_CHARS, TRUNCATION_MARKER);
}

/** `searchedFor` is absent unless the caller derived the query it searched. */
function renderSearchResult(
  result: CodeSearchResult,
  searchedFor?: string,
): string {
  const matches = result.matches.map((match) => ({
    path: match.path,
    name: match.name,
    snippets: match.snippets
      .slice(0, MAX_SNIPPETS_PER_MATCH)
      .map((snippet) =>
        snippet.length <= MAX_SNIPPET_CHARS
          ? snippet
          : snippet.slice(0, MAX_SNIPPET_CHARS) + SNIPPET_TRUNCATION_MARKER,
      ),
  }));
  return JSON.stringify(
    {
      ...(searchedFor === undefined ? {} : { searchedFor }),
      totalCount: result.totalCount,
      incompleteResults: result.incompleteResults,
      matches,
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

/** Segments too common to identify a file; searching one returns only noise. */
const GENERIC_PATH_SEGMENTS = new Set([
  "index",
  "mod",
  "main",
  "__init__",
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
  const segments = path.split("/");
  const file = segments.pop() ?? "";
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  for (const candidate of [base, ...segments.reverse()]) {
    if (
      !GENERIC_PATH_SEGMENTS.has(candidate.toLowerCase()) &&
      SEARCHABLE_STEM.test(candidate)
    ) {
      return candidate;
    }
  }
  throw new Error(
    `no distinctive name to search for in "${path}": every segment is a generic ` +
      "module name. Use search_repository with a symbol from the file instead.",
  );
}

const emptyInputSchema = z.strictObject({});

function pullRef(scope: ReviewToolScope) {
  return {
    owner: scope.owner,
    repo: scope.repo,
    pullRequestNumber: scope.pullRequestNumber,
  };
}

/** Exactly the seven read-only tools, bound to one pull request. */
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
        "snippets of the matching code, plus the total number of matches. " +
        "The search is always scoped to this repository; scope qualifiers are not allowed. " +
        "IMPORTANT: the index and the snippets are the repository's DEFAULT branch, not this " +
        "pull request's head. Snippets carry no line numbers, and files this pull request adds " +
        "or changes are not reflected. Never quote a snippet as the current state of a changed " +
        "file — re-read it with get_file first.",
      inputSchema: z.strictObject({ query: searchQuerySchema }),
      async execute({ query }) {
        const result = await github.searchCode({
          owner: scope.owner,
          repo: scope.repo,
          query,
        });
        return truncate(renderSearchResult(result));
      },
    }),
    find_importers: tool({
      description:
        "Find files that MENTION this file's name — a cheap proxy for \"what imports it\", NOT a " +
        "resolved import graph. It is a text search for the file's name stem, so results routinely " +
        "include unrelated files using the same word, and MISS importers that alias the path or " +
        "import the directory. The stem actually searched comes back as searchedFor. " +
        "IMPORTANT: it searches the repository's DEFAULT branch, so importers this pull request " +
        "adds are invisible, and an empty result means the search found nothing — not that nothing " +
        "imports the file. Confirm every result with get_file before relying on it.",
      inputSchema: z.strictObject({ path: repositoryPathSchema }),
      async execute({ path }) {
        const stem = importerSearchStem(path);
        const result = await github.searchCode({
          owner: scope.owner,
          repo: scope.repo,
          query: `"${stem}"`,
        });
        const subject = path.toLowerCase();
        return truncate(
          renderSearchResult(
            {
              ...result,
              matches: result.matches.filter(
                (match) => match.path.toLowerCase() !== subject,
              ),
            },
            stem,
          ),
        );
      },
    }),
  };
}
