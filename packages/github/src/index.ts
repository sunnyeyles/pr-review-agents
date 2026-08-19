/**
 * @pr-review/github
 *
 * GitHub authentication, Octokit client, and read-only PR tools:
 * clients that load PR details, changed files, and diffs, and publish
 * the "AI PR Review" check run.
 *
 * One way in, one client out: createTokenClient wraps the workflow
 * token the GitHub Action is handed and returns a
 * GithubInstallationClient. createInstallationClient is the shared
 * client body behind it, exported so an already-authenticated Octokit
 * can be wrapped directly.
 */
export { createInstallationClient, type OctokitLike } from "./app.js";
export { createTokenClient, type GithubTokenConfig } from "./token.js";
export {
  CHECK_RUN_NAME,
  type AnnotationLevel,
  type ChangedFile,
  type CheckRun,
  type CheckRunAnnotation,
  type CheckRunConclusion,
  type CheckRunOutput,
  type CodeSearchMatch,
  type CodeSearchRequest,
  type CreateCheckRunInput,
  type FileContentsRequest,
  type GithubInstallationClient,
  type PullRequestDetails,
  type PullRequestRef,
} from "./client.js";
