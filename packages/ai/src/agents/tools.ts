/**
 * The read-only, repository-scoped tools a review agent gets; there is no write
 * tool here. Repository scope comes from the job, not the model.
 */
import type { GithubInstallationClient } from "@pr-review/github";
import { errorMessage } from "@pr-review/logging";
import { z } from "zod";

/** The repository/PR coordinates a job pins its tools to. */
export interface ReviewToolScope {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
}

/**
 * The tool input_schema sent to the model. Derived from the Zod schema
 * that validates the same input, so the two cannot drift apart.
 */
interface ReviewToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
  /** Structural compatibility with ModelToolDefinition's JSON Schema. */
  [key: string]: unknown;
}

/**
 * Refinements have no JSON Schema equivalent, so they are absent here
 * and enforced in `run`, where a violation becomes an error tool_result.
 */
function toolInputSchema(schema: z.ZodType): ReviewToolInputSchema {
  const { $schema: _annotation, ...jsonSchema } = z.toJSONSchema(schema, {
    io: "input",
  });
  return jsonSchema as ReviewToolInputSchema;
}

interface ReviewTool {
  name: string;
  description: string;
  inputSchema: ReviewToolInputSchema;
  /** Validates the input, then performs the read-only GitHub call. */
  run(
    github: GithubInstallationClient,
    scope: ReviewToolScope,
    input: unknown,
  ): Promise<string>;
}

type ToolDispatchResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/** Tool results larger than this are truncated to bound token usage. */
const MAX_TOOL_RESULT_CHARS = 50_000;

const TRUNCATION_MARKER = "\n[... truncated: result exceeded the size limit]";

function truncate(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) {
    return content;
  }
  return content.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATION_MARKER;
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

function defineTool<Schema extends z.ZodType>(definition: {
  name: string;
  description: string;
  zodSchema: Schema;
  execute(
    github: GithubInstallationClient,
    scope: ReviewToolScope,
    input: z.output<Schema>,
  ): Promise<string>;
}): ReviewTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toolInputSchema(definition.zodSchema),
    async run(github, scope, input) {
      const parsed = definition.zodSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `invalid input for ${definition.name}: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
      return definition.execute(github, scope, parsed.data);
    },
  };
}

function pullRef(scope: ReviewToolScope) {
  return {
    owner: scope.owner,
    repo: scope.repo,
    pullRequestNumber: scope.pullRequestNumber,
  };
}

/** Exactly the six read-only tools. */
export const reviewTools: readonly ReviewTool[] = [
  defineTool({
    name: "get_pull_request",
    description:
      "Get the pull request's title, description, author, branches, and commit SHAs as JSON.",
    zodSchema: emptyInputSchema,
    async execute(github, scope) {
      const pullRequest = await github.getPullRequest(pullRef(scope));
      return truncate(JSON.stringify(pullRequest, null, 2));
    },
  }),
  defineTool({
    name: "list_changed_files",
    description:
      "List the files changed by the pull request (filename, status, additions, deletions) as JSON.",
    zodSchema: emptyInputSchema,
    async execute(github, scope) {
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
  defineTool({
    name: "get_diff",
    description: "Get the pull request's full unified diff.",
    zodSchema: emptyInputSchema,
    async execute(github, scope) {
      return truncate(await github.getDiff(pullRef(scope)));
    },
  }),
  defineTool({
    name: "get_file",
    description:
      "Read one file's contents at the pull request's HEAD commit (the proposed state). " +
      'The path is relative to the repository root, e.g. "src/index.ts".',
    zodSchema: z.strictObject({ path: repositoryPathSchema }),
    async execute(github, scope, input) {
      return truncate(
        await github.getFileContents({
          owner: scope.owner,
          repo: scope.repo,
          path: input.path,
          ref: scope.headSha,
        }),
      );
    },
  }),
  defineTool({
    name: "get_base_file",
    description:
      "Read one file's contents at the pull request's BASE commit (the state before this PR). " +
      'The path is relative to the repository root, e.g. "src/index.ts".',
    zodSchema: z.strictObject({ path: repositoryPathSchema }),
    async execute(github, scope, input) {
      return truncate(
        await github.getFileContents({
          owner: scope.owner,
          repo: scope.repo,
          path: input.path,
          ref: scope.baseSha,
        }),
      );
    },
  }),
  defineTool({
    name: "search_repository",
    description:
      "Search code within the pull request's repository. Returns matching file paths as JSON. " +
      "The search is always scoped to this repository; scope qualifiers are not allowed.",
    zodSchema: z.strictObject({ query: searchQuerySchema }),
    async execute(github, scope, input) {
      const matches = await github.searchCode({
        owner: scope.owner,
        repo: scope.repo,
        query: input.query,
      });
      return truncate(JSON.stringify(matches, null, 2));
    },
  }),
];

/** Never throws: every failure comes back as `{ ok: false }` for the agent loop. */
export async function dispatchReviewTool(
  github: GithubInstallationClient,
  scope: ReviewToolScope,
  name: string,
  input: unknown,
): Promise<ToolDispatchResult> {
  const tool = reviewTools.find((candidate) => candidate.name === name);
  if (!tool) {
    return { ok: false, error: `unknown tool: ${name}` };
  }
  try {
    return { ok: true, content: await tool.run(github, scope, input) };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  }
}
