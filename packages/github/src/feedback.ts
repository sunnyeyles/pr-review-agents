/**
 * The read-only surface the feedback collector needs: which pull
 * requests were touched recently, the review comments on them, who
 * reacted to each, and whether that person can push to the repository.
 * Nothing here writes to GitHub.
 */
import { Octokit } from "@octokit/rest";
import { z } from "zod";

import { httpStatus } from "./errors.js";
import type { PullRequestRef } from "./client.js";

export interface RepositoryRef {
  owner: string;
  repo: string;
}

/** A pull request and when anything on it last changed. */
export interface RecentPullRequest {
  number: number;
  updatedAt: Date;
}

/** One inline review comment with GitHub's own reaction tallies. */
export interface ReactedReviewComment {
  id: number;
  body: string;
  thumbsUp: number;
  thumbsDown: number;
}

/** One reaction on a review comment. `content` is GitHub's name: "+1", "-1", "eyes", ... */
export interface CommentReaction {
  id: number;
  content: string;
  user: string;
}

/** GitHub's collaborator permission levels, lowest first. */
export type CollaboratorPermission = "none" | "read" | "write" | "admin";

export interface GithubFeedbackClient {
  /** Pull requests in any state updated since `since`, most recent first. */
  listPullRequestsUpdatedSince(
    repository: RepositoryRef,
    since: Date,
  ): Promise<RecentPullRequest[]>;
  listReactedReviewComments(ref: PullRequestRef): Promise<ReactedReviewComment[]>;
  listReviewCommentReactions(
    repository: RepositoryRef,
    commentId: number,
  ): Promise<CommentReaction[]>;
  /** "none" for a user who is not a collaborator at all. */
  getCollaboratorPermission(
    repository: RepositoryRef,
    username: string,
  ): Promise<CollaboratorPermission>;
}

/** The slice of Octokit the feedback client consumes; tests stub it structurally. */
export interface FeedbackOctokitLike {
  rest: {
    pulls: {
      list(params: {
        owner: string;
        repo: string;
        state: "all";
        sort: "updated";
        direction: "desc";
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
    };
    reactions: {
      listForPullRequestReviewComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        per_page: number;
        page: number;
      }): Promise<{ data: unknown }>;
    };
    repos: {
      getCollaboratorPermissionLevel(params: {
        owner: string;
        repo: string;
        username: string;
      }): Promise<{ data: unknown }>;
    };
  };
}

const PER_PAGE = 100;

const pullListSchema = z.array(
  z.object({ number: z.number(), updated_at: z.string() }),
);

const reactedCommentsSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string(),
    reactions: z
      .object({ "+1": z.number().default(0), "-1": z.number().default(0) })
      .optional(),
  }),
);

const reactionsSchema = z.array(
  z.object({
    id: z.number(),
    content: z.string(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);

const permissionSchema = z.object({ permission: z.string() });

/** Anything GitHub adds beyond the four documented levels counts as no access. */
function toPermission(value: string): CollaboratorPermission {
  switch (value) {
    case "admin":
    case "write":
    case "read":
    case "none":
      return value;
    default:
      return "none";
  }
}

/** Walks a paged endpoint. A short page is the only signal that it was the last. */
async function* pages<T>(
  fetchPage: (page: number) => Promise<{ data: unknown }>,
  schema: { parse: (data: unknown) => T[] },
): AsyncGenerator<T[]> {
  for (let page = 1; ; page += 1) {
    const items = schema.parse((await fetchPage(page)).data);
    yield items;
    if (items.length < PER_PAGE) {
      return;
    }
  }
}

export function createFeedbackClient(
  octokit: FeedbackOctokitLike,
): GithubFeedbackClient {
  return {
    async listPullRequestsUpdatedSince(repository, since) {
      const pulls: RecentPullRequest[] = [];
      const source = pages(
        (page) =>
          octokit.rest.pulls.list({
            owner: repository.owner,
            repo: repository.repo,
            state: "all",
            sort: "updated",
            direction: "desc",
            per_page: PER_PAGE,
            page,
          }),
        pullListSchema,
      );
      for await (const pagePulls of source) {
        for (const pull of pagePulls) {
          const updatedAt = new Date(pull.updated_at);
          // Sorted newest first, so the first stale one ends the walk.
          if (updatedAt < since) {
            return pulls;
          }
          pulls.push({ number: pull.number, updatedAt });
        }
      }
      return pulls;
    },

    async listReactedReviewComments(ref) {
      const comments: ReactedReviewComment[] = [];
      const source = pages(
        (page) =>
          octokit.rest.pulls.listReviewComments({
            owner: ref.owner,
            repo: ref.repo,
            pull_number: ref.pullRequestNumber,
            per_page: PER_PAGE,
            page,
          }),
        reactedCommentsSchema,
      );
      for await (const pageComments of source) {
        for (const comment of pageComments) {
          comments.push({
            id: comment.id,
            body: comment.body,
            thumbsUp: comment.reactions?.["+1"] ?? 0,
            thumbsDown: comment.reactions?.["-1"] ?? 0,
          });
        }
      }
      return comments;
    },

    async listReviewCommentReactions(repository, commentId) {
      const reactions: CommentReaction[] = [];
      const source = pages(
        (page) =>
          octokit.rest.reactions.listForPullRequestReviewComment({
            owner: repository.owner,
            repo: repository.repo,
            comment_id: commentId,
            per_page: PER_PAGE,
            page,
          }),
        reactionsSchema,
      );
      for await (const pageReactions of source) {
        for (const reaction of pageReactions) {
          // A deleted account leaves a reaction nobody can be held to.
          if (reaction.user !== null) {
            reactions.push({
              id: reaction.id,
              content: reaction.content,
              user: reaction.user.login,
            });
          }
        }
      }
      return reactions;
    },

    async getCollaboratorPermission(repository, username) {
      try {
        const response = await octokit.rest.repos.getCollaboratorPermissionLevel(
          { owner: repository.owner, repo: repository.repo, username },
        );
        return toPermission(permissionSchema.parse(response.data).permission);
      } catch (error: unknown) {
        if (httpStatus(error) === 404) {
          return "none";
        }
        throw error;
      }
    },
  };
}

export interface FeedbackClientConfig {
  token: string;
  /** Injectable Octokit factory; defaults to a real token-authenticated Octokit. */
  createOctokit?: ((token: string) => FeedbackOctokitLike) | undefined;
}

export function createTokenFeedbackClient(
  config: FeedbackClientConfig,
): GithubFeedbackClient {
  const createOctokit =
    config.createOctokit ?? ((token: string) => new Octokit({ auth: token }));
  return createFeedbackClient(createOctokit(config.token));
}
