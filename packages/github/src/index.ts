/**
 * One way in, one client out: createTokenClient wraps the workflow token
 * and returns a GithubInstallationClient. OctokitLike is public only
 * because GithubTokenConfig lets a caller inject its own Octokit.
 */
export type { OctokitLike } from "./app.js";
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
