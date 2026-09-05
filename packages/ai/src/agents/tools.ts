/**
 * The read-only, repository-scoped tools a review agent gets; there is no write
 * tool here. Repository scope comes from the job, not the model.
 */
import type { GithubInstallationClient } from "@pr-review/github";
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

function pullRef(scope: ReviewToolScope) {
  return {
    owner: scope.owner,
    repo: scope.repo,
    pullRequestNumber: scope.pullRequestNumber,
  };
}

/** Exactly the six read-only tools, bound to one pull request. */
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
