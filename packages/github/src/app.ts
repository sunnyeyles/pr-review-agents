import { z } from "zod";

import {
  CHECK_RUN_NAME,
  type ChangedFile,
  type CheckRun,
  type CheckRunAnnotation,
  type CodeSearchRequest,
  type CodeSearchResult,
  type CommitFilesRequest,
  type CommitHistoryRequest,
  type CreateCheckRunInput,
  type CreateReviewInput,
  type ExistingReviewComment,
  type FileContentsRequest,
  type GithubInstallationClient,
  type PullRequestDetails,
  type PullRequestRef,
  type PullRequestReview,
  type ReviewThread,
  type WriteFileRequest,
} from "./client.js";
import { httpStatus } from "./errors.js";

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
          body: string;
        }[];
      }): Promise<{ data: unknown }>;
    };
    repos: {
      get(params: { owner: string; repo: string }): Promise<{ data: unknown }>;
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
      createOrUpdateFileContents(params: {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        branch: string;
        sha?: string;
      }): Promise<{ data: unknown }>;
    };
    git: {
      getRef(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: unknown }>;
      createRef(params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
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
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
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

const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            isOutdated
            comments(first: 1) { nodes { body } }
          }
        }
      }
    }
  }
`;

const reviewThreadsSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(
          z.object({
            isResolved: z.boolean(),
            isOutdated: z.boolean(),
            comments: z.object({
              nodes: z.array(z.object({ body: z.string() })),
            }),
          }),
        ),
      }),
    }),
  }),
});

/** The head SHA of a ref; a missing ref is a 404, not an empty response. */
const refSchema = z.object({ object: z.object({ sha: z.string() }) });

const repositorySchema = z.object({ default_branch: z.string() });

/** Only a plain file has a blob SHA to overwrite; a directory does not. */
const existingFileSchema = z.object({ type: z.string(), sha: z.string() });

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

/** The head SHA of one branch, or undefined when GitHub says it has none. */
async function branchSha(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const response = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    return refSchema.parse(response.data).object.sha;
  } catch (error) {
    if (httpStatus(error) === 404) {
      return undefined;
    }
    throw error;
  }
}

/** Branches the default branch's head when `branch` does not exist yet. */
async function ensureBranch(
  octokit: OctokitLike,
  request: WriteFileRequest,
): Promise<void> {
  const { owner, repo, branch } = request;
  if ((await branchSha(octokit, owner, repo, branch)) !== undefined) {
    return;
  }
  const repository = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repositorySchema.parse(repository.data).default_branch;
  const sha = await branchSha(octokit, owner, repo, defaultBranch);
  if (sha === undefined) {
    throw new Error(
      `${owner}/${repo} has no ${defaultBranch} branch to branch ${branch} from`,
    );
  }
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha,
  });
}

/** The blob SHA an overwrite must supply; undefined when the file is new. */
async function existingFileSha(
  octokit: OctokitLike,
  request: WriteFileRequest,
): Promise<string | undefined> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner: request.owner,
      repo: request.repo,
      path: request.path,
      ref: request.branch,
    });
    if (Array.isArray(response.data)) {
      throw new Error(`${request.path} is a directory, not a file`);
    }
    const data = existingFileSchema.parse(response.data);
    if (data.type !== "file") {
      throw new Error(`${request.path} is a ${data.type}, not a file`);
    }
    return data.sha;
  } catch (error) {
    if (httpStatus(error) === 404) {
      return undefined;
    }
    throw error;
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

    async listReviewThreads(ref: PullRequestRef): Promise<ReviewThread[]> {
      const threads: ReviewThread[] = [];
      let cursor: string | null = null;
      for (;;) {
        const response: unknown = await octokit.graphql(REVIEW_THREADS_QUERY, {
          owner: ref.owner,
          name: ref.repo,
          number: ref.pullRequestNumber,
          cursor,
        });
        const page =
          reviewThreadsSchema.parse(response).repository.pullRequest
            .reviewThreads;
        for (const node of page.nodes) {
          const body = node.comments.nodes[0]?.body;
          if (body !== undefined) {
            threads.push({
              body,
              isResolved: node.isResolved,
              isOutdated: node.isOutdated,
            });
          }
        }
        if (!page.pageInfo.hasNextPage) {
          return threads;
        }
        cursor = page.pageInfo.endCursor;
      }
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
          side: "RIGHT",
          body: comment.body,
        })),
      });
      return reviewResponseSchema.parse(response.data);
    },

    async writeFileOnBranch(request: WriteFileRequest): Promise<void> {
      await ensureBranch(octokit, request);
      const sha = await existingFileSha(octokit, request);
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: request.owner,
        repo: request.repo,
        path: request.path,
        message: request.message,
        content: Buffer.from(request.content, "utf8").toString("base64"),
        branch: request.branch,
        ...(sha === undefined ? {} : { sha }),
      });
    },
  };
}
