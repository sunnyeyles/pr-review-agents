/**
 * Turns thumbs reactions on this system's review comments into Langfuse
 * scores on the run that produced each finding. Runs outside any review,
 * on a schedule; nothing here influences a review in progress.
 *
 * An emoji is a safe signal: it is a click, not text, so it cannot carry
 * an instruction. Who clicked still matters — on a public repository
 * anyone can react, so only people who can push to the repository count.
 */
import type { FeedbackScore, FeedbackScoreSink } from "@pr-review/ai";
import type {
  CollaboratorPermission,
  GithubFeedbackClient,
  RepositoryRef,
} from "@pr-review/github";
import { createConsoleLogger, type StructuredLogger } from "@pr-review/logging";

import { parseFeedbackMarker, postedFindingKeys } from "./render-review.js";

export interface CollectFeedbackOptions {
  repository: RepositoryRef;
  /** Pull requests untouched since this instant are not visited. */
  since: Date;
  /** Decide and report everything; record nothing. */
  dryRun?: boolean | undefined;
  logger?: StructuredLogger | undefined;
}

export interface CollectFeedbackReport {
  pullRequestsVisited: number;
  commentsScanned: number;
  /** Thumbs reactions found, before any filtering. */
  reactionsFound: number;
  /** Scores recorded (or, on a dry run, that would have been). */
  scoresRecorded: number;
  /** Reactions on a comment posted before runs were traced. */
  skippedUntraced: number;
  /** Reactions from people who cannot push to the repository. */
  skippedNoWriteAccess: number;
}

const THUMBS: Record<string, 0 | 1> = { "+1": 1, "-1": 0 };

/** Write and admin are the levels that can push; read and none are not. */
export function canPush(permission: CollaboratorPermission): boolean {
  return permission === "write" || permission === "admin";
}

/** A finding key stands in for a title the marker does not carry. */
function describeFinding(body: string): string {
  const [key] = postedFindingKeys([{ body }]);
  return key ?? "unknown finding";
}

export async function collectFeedback(
  github: GithubFeedbackClient,
  sink: FeedbackScoreSink,
  {
    repository,
    since,
    dryRun = false,
    logger = createConsoleLogger(),
  }: CollectFeedbackOptions,
): Promise<CollectFeedbackReport> {
  const repositoryName = `${repository.owner}/${repository.repo}`;
  const report: CollectFeedbackReport = {
    pullRequestsVisited: 0,
    commentsScanned: 0,
    reactionsFound: 0,
    scoresRecorded: 0,
    skippedUntraced: 0,
    skippedNoWriteAccess: 0,
  };
  // One permission lookup per person per run, however many times they reacted.
  const permissions = new Map<string, Promise<CollaboratorPermission>>();
  const permissionOf = (username: string) => {
    let lookup = permissions.get(username);
    if (lookup === undefined) {
      lookup = github.getCollaboratorPermission(repository, username);
      permissions.set(username, lookup);
    }
    return lookup;
  };

  const pulls = await github.listPullRequestsUpdatedSince(repository, since);
  for (const pull of pulls) {
    report.pullRequestsVisited += 1;
    const ref = { ...repository, pullRequestNumber: pull.number };
    const comments = await github.listReactedReviewComments(ref);

    for (const comment of comments) {
      const meta = parseFeedbackMarker(comment.body);
      if (meta === undefined) {
        continue;
      }
      report.commentsScanned += 1;
      // GitHub's tallies are free; the per-reaction listing is a call each.
      if (comment.thumbsUp === 0 && comment.thumbsDown === 0) {
        continue;
      }

      const reactions = await github.listReviewCommentReactions(
        repository,
        comment.id,
      );
      for (const reaction of reactions) {
        const value = THUMBS[reaction.content];
        if (value === undefined) {
          continue;
        }
        report.reactionsFound += 1;

        if (meta.traceId === undefined) {
          report.skippedUntraced += 1;
          continue;
        }
        if (!canPush(await permissionOf(reaction.user))) {
          report.skippedNoWriteAccess += 1;
          logger.info("feedback.skipped_no_write_access", {
            repository: repositoryName,
            pullRequestNumber: pull.number,
            commentId: comment.id,
            user: reaction.user,
          });
          continue;
        }

        const finding = describeFinding(comment.body);
        const score: FeedbackScore = {
          id: `github-reaction-${reaction.id}`,
          traceId: meta.traceId,
          value,
          comment: `${reaction.content} from ${reaction.user} on ${repositoryName}#${pull.number} (${meta.category}: ${finding})`,
          metadata: {
            repository: repositoryName,
            pullRequestNumber: pull.number,
            commentId: comment.id,
            reactionId: reaction.id,
            reaction: reaction.content,
            user: reaction.user,
            category: meta.category,
            finding,
          },
        };
        report.scoresRecorded += 1;
        logger.info(dryRun ? "feedback.would_record" : "feedback.recorded", {
          repository: repositoryName,
          pullRequestNumber: pull.number,
          commentId: comment.id,
          traceId: meta.traceId,
          category: meta.category,
          value,
        });
        if (!dryRun) {
          sink.record(score);
        }
      }
    }
  }

  if (!dryRun) {
    await sink.flush();
  }
  return report;
}
