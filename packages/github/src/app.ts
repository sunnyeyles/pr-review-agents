import { z } from "zod";

import {
  CHECK_RUN_NAME,
  type BranchTipRequest,
  type ChangedFile,
  type CheckRun,
  type CheckRunAnnotation,
  type CodeSearchRequest,
  type CodeSearchResult,
  type CommitFilesRequest,
  type CommitHistoryRequest,
  type CommitMessageRequest,
  type CommitRef,
  type CreateCheckRunInput,
  type CreateCommitInput,
  type CreateReviewInput,
  type ExistingReviewComment,
  type FileContentsRequest,
  type GithubInstallationClient,
  type PullRequestDetails,
  type PullRequestRef,
  type PullRequestReview,
} from "./client.js";

/**
 * The slice of Octokit this package consumes. Octokit satisfies it
 * structurally; tests inject a stub so no real network calls happen.
 */
export interface OctokitLike {
  rest: {
    pulls: {
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
        mediaType?: { format: "diff" };
      }): Promise<{ data: unknown }>;
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: unknown }>;
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: unknown }>;
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        body: string;
        event: "COMMENT";
        comments: {
          path: string;
          line: number;
          side: "RIGHT";
          start_line?: number;
          start_side?: "RIGHT";
          body: string;
        }[];
      }): Promise<{ data: unknown }>;
    };
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }): Promise<{ data: unknown }>;
      listCommits(params: {
        owner: string;
        repo: string;
        path: string;
        per_page: number;
      }): Promise<{ data: unknown }>;
      getCommit(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: unknown }>;
    };
    git: {
      getRef(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: unknown }>;
      createTree(params: {
        owner: string;
        repo: string;
        base_tree: string;
        tree: {
          path: string;
          mode: "100644";
          type: "blob";
          content: string;
        }[];
      }): Promise<{ data: unknown }>;
      createCommit(params: {
        owner: string;
        repo: string;
        message: string;
        tree: string;
        parents: string[];
      }): Promise<{ data: unknown }>;
      updateRef(params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
        force: boolean;
      }): Promise<{ data: unknown }>;
    };
    search: {
      code(params: {
        q: string;
        per_page: number;
        mediaType: { format: string };
      }): Promise<{ data: unknown }>;
    };
    checks: {
      create(params: {
        owner: string;
        repo: string;
        name: string;
        head_sha: string;
        status: "completed";
        conclusion: "success" | "failure" | "neutral";
        output: {
          title: string;
          summary: string;
          text?: string;
          annotations?: CheckRunAnnotation[];
        };
      }): Promise<{ data: unknown }>;
    };
  };
}

const PAGE_SIZE = 100;

/** Code search results returned per query; agents need hints, not dumps. */
const SEARCH_RESULTS_PER_PAGE = 20;

/** The fields of a pulls.get response we map into PullRequestDetails. */
const pullResponseSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ ref: z.string(), sha: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
});

const changedFilesSchema = z.array(
  z.object({
    filename: z.string(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
  }),
);

const checkRunResponseSchema = z.object({ id: z.number() });

const reviewResponseSchema = z.object({ id: z.number() });

const reviewCommentsSchema = z.array(z.object({ body: z.string() }));

/** A repos.getContent response for a single (non-directory) entry. */
const fileContentsSchema = z.object({
  type: z.string(),
  encoding: z.string(),
  content: z.string(),
});

/** Only present with the text-match media type; every field is optional upstream. */
const textMatchesSchema = z
  .array(
    z.object({
      property: z.string().optional(),
      fragment: z.string().optional(),
    }),
  )
  .optional();

const commitListSchema = z.array(z.object({ sha: z.string() }));

const objectShaSchema = z.object({ sha: z.string() });

const refSchema = z.object({ object: z.object({ sha: z.string() }) });

const commitMessageSchema = z.object({
  commit: z.object({ message: z.string() }),
});

/** An empty commit (a merge with no conflicts) carries no files array. */
const commitFilesSchema = z.object({
  files: z.array(z.object({ filename: z.string() })).optional(),
});

const codeSearchSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      repository: z.object({ full_name: z.string() }),
      text_matches: textMatchesSchema,
    }),
  ),
});

/** Verbatim. Path-property fragments only repeat the path, so they are dropped. */
function contentFragments(
  textMatches: z.infer<typeof textMatchesSchema>,
): string[] {
  return (textMatches ?? [])
    .filter((match) => match.property === undefined || match.property === "content")
    .map((match) => match.fragment)
    .filter((fragment) => fragment !== undefined);
}

/** Walks numbered pages until a short one; GitHub sends no other end marker. */
async function paginate<T>(
  fetchPage: (page: number) => Promise<{ data: unknown }>,
  parsePage: (data: unknown) => T[],
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const pageItems = parsePage((await fetchPage(page)).data);
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) {
      return items;
    }
  }
}

/**
 * Wraps an authenticated Octokit in the read-only PR client, so
 * authentication is the only thing a caller has to supply.
 */
export function createInstallationClient(
  octokit: OctokitLike,
): GithubInstallationClient {
  return {
    async getPullRequest(ref: PullRequestRef): Promise<PullRequestDetails> {
      const response = await octokit.rest.pulls.get({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.pullRequestNumber,
      });
      const data = pullResponseSchema.parse(response.data);
      return {
        number: data.number,
        title: data.title,
        body: data.body,
        author: data.user?.login ?? null,
        baseRef: data.base.ref,
        baseSha: data.base.sha,
        headRef: data.head.ref,
        headSha: data.head.sha,
      };
    },

    listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]> {
      return paginate(
        (page) =>
          octokit.rest.pulls.listFiles({
            owner: ref.owner,
            repo: ref.repo,
            pull_number: ref.pullRequestNumber,
            per_page: PAGE_SIZE,
            page,
          }),
        (data) => changedFilesSchema.parse(data),
      );
    },

    async getDiff(ref: PullRequestRef): Promise<string> {
      const response = await octokit.rest.pulls.get({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.pullRequestNumber,
        mediaType: { format: "diff" },
      });
      return z.string().parse(response.data);
    },

    async getFileContents(request: FileContentsRequest): Promise<string> {
      const response = await octokit.rest.repos.getContent({
        owner: request.owner,
        repo: request.repo,
        path: request.path,
        ref: request.ref,
      });
      if (Array.isArray(response.data)) {
        throw new Error(`${request.path} is a directory, not a file`);
      }
      const data = fileContentsSchema.parse(response.data);
      if (data.type !== "file") {
        throw new Error(`${request.path} is a ${data.type}, not a file`);
      }
      if (data.encoding !== "base64") {
        throw new Error(
          `${request.path} has unsupported content encoding "${data.encoding}"` +
            " (the file may be too large to fetch)",
        );
      }
      return Buffer.from(data.content, "base64").toString("utf8");
    },

    async searchCode(request: CodeSearchRequest): Promise<CodeSearchResult> {
      const repository = `${request.owner}/${request.repo}`;
      const response = await octokit.rest.search.code({
        q: `${request.query} repo:${repository}`,
        per_page: SEARCH_RESULTS_PER_PAGE,
        mediaType: { format: "text-match" },
      });
      const data = codeSearchSchema.parse(response.data);
      // The query is already repo-scoped; this filter is belt and braces.
      const matches = data.items
        .filter(
          (item) =>
            item.repository.full_name.toLowerCase() ===
            repository.toLowerCase(),
        )
        .map((item) => ({
          path: item.path,
          name: item.name,
          snippets: contentFragments(item.text_matches),
        }));
      return {
        matches,
        totalCount: data.total_count,
        incompleteResults: data.incomplete_results,
      };
    },

    async listCommitShas(request: CommitHistoryRequest): Promise<string[]> {
      const response = await octokit.rest.repos.listCommits({
        owner: request.owner,
        repo: request.repo,
        path: request.path,
        per_page: request.limit,
      });
      return commitListSchema
        .parse(response.data)
        .map((commit) => commit.sha);
    },

    async listCommitFiles(request: CommitFilesRequest): Promise<string[]> {
      const response = await octokit.rest.repos.getCommit({
        owner: request.owner,
        repo: request.repo,
        ref: request.sha,
      });
      const data = commitFilesSchema.parse(response.data);
      return (data.files ?? []).map((file) => file.filename);
    },

    async getBranchTip(request: BranchTipRequest): Promise<string> {
      const response = await octokit.rest.git.getRef({
        owner: request.owner,
        repo: request.repo,
        ref: `heads/${request.branch}`,
      });
      return refSchema.parse(response.data).object.sha;
    },

    async getCommitMessage(request: CommitMessageRequest): Promise<string> {
      const response = await octokit.rest.repos.getCommit({
        owner: request.owner,
        repo: request.repo,
        ref: request.sha,
      });
      return commitMessageSchema.parse(response.data).commit.message;
    },

    async createCheckRun(input: CreateCheckRunInput): Promise<CheckRun> {
      const output: {
        title: string;
        summary: string;
        text?: string;
        annotations?: CheckRunAnnotation[];
      } = { title: input.output.title, summary: input.output.summary };
      if (input.output.text !== undefined) {
        output.text = input.output.text;
      }
      if (input.output.annotations !== undefined && input.output.annotations.length > 0) {
        output.annotations = input.output.annotations;
      }
      const response = await octokit.rest.checks.create({
        owner: input.owner,
        repo: input.repo,
        name: CHECK_RUN_NAME,
        head_sha: input.headSha,
        status: "completed",
        conclusion: input.conclusion,
        output,
      });
      return checkRunResponseSchema.parse(response.data);
    },

    listReviewComments(ref: PullRequestRef): Promise<ExistingReviewComment[]> {
      return paginate(
        (page) =>
          octokit.rest.pulls.listReviewComments({
            owner: ref.owner,
            repo: ref.repo,
            pull_number: ref.pullRequestNumber,
            per_page: PAGE_SIZE,
            page,
          }),
        (data) => reviewCommentsSchema.parse(data),
      );
    },

    async createReview(input: CreateReviewInput): Promise<PullRequestReview> {
      const response = await octokit.rest.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullRequestNumber,
        commit_id: input.commitSha,
        body: input.body,
        event: "COMMENT",
        comments: input.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: "RIGHT" as const,
          // GitHub rejects start_line when it equals line.
          ...(comment.startLine !== undefined && comment.startLine < comment.line
            ? { start_line: comment.startLine, start_side: "RIGHT" as const }
            : {}),
          body: comment.body,
        })),
      });
      return reviewResponseSchema.parse(response.data);
    },

    async createCommitOnBranch(input: CreateCommitInput): Promise<CommitRef> {
      // A commit SHA is a valid base_tree, so the tree needs no extra read.
      const tree = await octokit.rest.git.createTree({
        owner: input.owner,
        repo: input.repo,
        base_tree: input.baseSha,
        tree: input.files.map((file) => ({
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          content: file.content,
        })),
      });
      const commit = await octokit.rest.git.createCommit({
        owner: input.owner,
        repo: input.repo,
        message: input.message,
        tree: objectShaSchema.parse(tree.data).sha,
        parents: [input.baseSha],
      });
      const sha = objectShaSchema.parse(commit.data).sha;
      // Never forced: a branch that moved during the review must lose the race.
      await octokit.rest.git.updateRef({
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.branch}`,
        sha,
        force: false,
      });
      return { sha };
    },
  };
}
