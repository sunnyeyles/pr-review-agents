/**
 * @pr-review/github
 *
 * GitHub authentication, Octokit client, and read-only PR tools:
 * clients that load PR details, changed files, and diffs, and publish
 * the "AI PR Review" check run.
 *
 * Two ways in, one client out. createGithubApp authenticates as a
 * GitHub App installation (the AWS delivery path); createTokenClient
 * wraps a workflow token (the GitHub Action). Both produce a
 * GithubInstallationClient, so nothing downstream knows which was used.
 */
export {
  createGithubApp,
  createInstallationClient,
  type GithubAppConfig,
  type OctokitLike,
} from "./app.js";
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
  type InstallationClientFactory,
  type PullRequestDetails,
  type PullRequestRef,
} from "./client.js";
