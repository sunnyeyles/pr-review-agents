/**
 * The read-only, repository-scoped tools a review agent gets; there is no write
 * tool here. Repository scope comes from the job, not the model.
 */
import type {
  ChangedFile,
  GithubInstallationClient,
  PullRequestDetails,
} from "@pr-review/github";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { truncateWithMarker } from "./truncate.js";

/** The pull request a job pins its tools to, with what was already loaded about it. */
export interface ReviewToolScope {
  owner: string;
  repo: string;
  pullRequest: PullRequestDetails;
  changedFiles: readonly ChangedFile[];
  diff: string;
}

/** Tool results larger than this are truncated to bound token usage. */
const MAX_TOOL_RESULT_CHARS = 50_000;

const TRUNCATION_MARKER = "\n[... truncated: result exceeded the size limit]";

function truncate(content: string): string {
  return truncateWithMarker(content, MAX_TOOL_RESULT_CHARS, TRUNCATION_MARKER);
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

/** Exactly the six read-only tools, bound to one pull request. */
export function createReviewTools(
  github: GithubInstallationClient,
  scope: ReviewToolScope,
): ToolSet {
  return {
    get_pull_request: tool({
      description:
        "Get the pull request's title, description, author, branches, and commit SHAs as JSON. " +
        "The opening message already carries these.",
      inputSchema: emptyInputSchema,
      async execute() {
        return truncate(JSON.stringify(scope.pullRequest, null, 2));
      },
    }),
    list_changed_files: tool({
      description:
        "List the files changed by the pull request (filename, status, additions, deletions) as JSON. " +
        "The opening message already carries this list.",
      inputSchema: emptyInputSchema,
      async execute() {
        const listed = scope.changedFiles.map(
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
        "Get one changed file's patch by path, or the whole unified diff with no path. " +
        "The opening message already carries the whole diff; ask for it again only if it " +
        "was truncated there, and prefer a path.",
      inputSchema: z.strictObject({
        path: repositoryPathSchema
          .optional()
          .describe("A changed file's path for its patch alone; omit for the whole diff."),
      }),
      async execute({ path }) {
        return truncate(
          path === undefined ? scope.diff : patchFor(scope.changedFiles, path),
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
            owner: scope.owner,
            repo: scope.repo,
            path,
            ref: scope.pullRequest.headSha,
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
            ref: scope.pullRequest.baseSha,
          }),
        );
      },
    }),
    search_repository: tool({
      description:
        "Search code within the pull request's repository. Returns matching file paths as JSON. " +
        "The search is always scoped to this repository; scope qualifiers are not allowed.",
      inputSchema: z.strictObject({ query: searchQuerySchema }),
      async execute({ query }) {
        const matches = await github.searchCode({
          owner: scope.owner,
          repo: scope.repo,
          query,
        });
        return truncate(JSON.stringify(matches, null, 2));
      },
    }),
  };
}
