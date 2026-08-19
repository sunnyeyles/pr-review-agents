import { z } from "zod";

import {
  CHECK_RUN_NAME,
  type ChangedFile,
  type CheckRun,
  type CheckRunAnnotation,
  type CodeSearchMatch,
  type CodeSearchRequest,
  type CreateCheckRunInput,
  type FileContentsRequest,
  type GithubInstallationClient,
  type PullRequestDetails,
  type PullRequestRef,
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
    };
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }): Promise<{ data: unknown }>;
    };
    search: {
      code(params: { q: string; per_page: number }): Promise<{ data: unknown }>;
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

const FILES_PER_PAGE = 100;

/** Code search results returned per query; agents need hints, not dumps. */
const SEARCH_RESULTS_PER_PAGE = 20;

/** The fields of a pulls.get response we map into PullRequestDetails. */
const pullResponseSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
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

/** A repos.getContent response for a single (non-directory) entry. */
const fileContentsSchema = z.object({
  type: z.string(),
  encoding: z.string(),
  content: z.string(),
});

const codeSearchSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      repository: z.object({ full_name: z.string() }),
    }),
  ),
});

/**
 * Wraps an authenticated Octokit in the read-only PR client the review
 * pipeline consumes. Exported so authentication stays the only thing a
 * caller has to supply: createTokenClient (token.ts) builds the
 * workflow-token Octokit and hands it here, and everything downstream
 * sees a plain GithubInstallationClient.
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
        state: data.state,
        author: data.user?.login ?? null,
        baseRef: data.base.ref,
        baseSha: data.base.sha,
        headRef: data.head.ref,
        headSha: data.head.sha,
      };
    },

    async listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]> {
      const files: ChangedFile[] = [];
      for (let page = 1; ; page += 1) {
        const response = await octokit.rest.pulls.listFiles({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.pullRequestNumber,
          per_page: FILES_PER_PAGE,
          page,
        });
        const pageFiles = changedFilesSchema.parse(response.data);
        files.push(...pageFiles);
        if (pageFiles.length < FILES_PER_PAGE) {
          return files;
        }
      }
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

    async searchCode(request: CodeSearchRequest): Promise<CodeSearchMatch[]> {
      const repository = `${request.owner}/${request.repo}`;
      const response = await octokit.rest.search.code({
        q: `${request.query} repo:${repository}`,
        per_page: SEARCH_RESULTS_PER_PAGE,
      });
      const data = codeSearchSchema.parse(response.data);
      // The query is already repo-scoped; the filter is belt and braces
      // so nothing outside the PR's repository can ever be returned.
      return data.items
        .filter(
          (item) =>
            item.repository.full_name.toLowerCase() ===
            repository.toLowerCase(),
        )
        .map((item) => ({ path: item.path, name: item.name }));
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
  };
}
