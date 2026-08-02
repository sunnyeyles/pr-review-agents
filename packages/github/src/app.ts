import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { z } from "zod";

import {
  CHECK_RUN_NAME,
  type ChangedFile,
  type CheckRun,
  type CreateCheckRunInput,
  type GithubInstallationClient,
  type InstallationClientFactory,
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
    checks: {
      create(params: {
        owner: string;
        repo: string;
        name: string;
        head_sha: string;
        status: "completed";
        conclusion: "success" | "failure" | "neutral";
        output: { title: string; summary: string; text?: string };
      }): Promise<{ data: unknown }>;
    };
  };
}

export interface GithubAppConfig {
  /** GitHub App ID (numeric, but configured as a string). */
  appId: string;
  /** PEM-encoded GitHub App private key. */
  privateKey: string;
  /** Injectable Octokit factory; defaults to a real App-authenticated Octokit. */
  createOctokit?: ((installationId: number) => OctokitLike) | undefined;
}

const FILES_PER_PAGE = 100;

/** The fields of a pulls.get response we map into PullRequestDetails. */
const pullResponseSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ ref: z.string() }),
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

function createInstallationClient(octokit: OctokitLike): GithubInstallationClient {
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

    async createCheckRun(input: CreateCheckRunInput): Promise<CheckRun> {
      const response = await octokit.rest.checks.create({
        owner: input.owner,
        repo: input.repo,
        name: CHECK_RUN_NAME,
        head_sha: input.headSha,
        status: "completed",
        conclusion: input.conclusion,
        output:
          input.output.text === undefined
            ? { title: input.output.title, summary: input.output.summary }
            : {
                title: input.output.title,
                summary: input.output.summary,
                text: input.output.text,
              },
      });
      return checkRunResponseSchema.parse(response.data);
    },
  };
}

function defaultCreateOctokit(
  config: Pick<GithubAppConfig, "appId" | "privateKey">,
): (installationId: number) => OctokitLike {
  return (installationId) =>
    new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId,
      },
    });
}

/**
 * Builds an installation-client factory for one GitHub App. Clients are
 * cached per installation so warm Lambda invocations reuse Octokit's
 * token cache instead of re-authenticating on every job.
 */
export function createGithubApp(config: GithubAppConfig): InstallationClientFactory {
  const createOctokit = config.createOctokit ?? defaultCreateOctokit(config);
  const clients = new Map<number, GithubInstallationClient>();
  return (installationId) => {
    let client = clients.get(installationId);
    if (!client) {
      client = createInstallationClient(createOctokit(installationId));
      clients.set(installationId, client);
    }
    return client;
  };
}
