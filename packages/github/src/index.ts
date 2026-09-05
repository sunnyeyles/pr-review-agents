/**
 * One way in, one client out: createTokenClient wraps the workflow token
 * and returns a GithubInstallationClient.
 *
 * A name reaches this barrel when something outside the package imports
 * it; everything else stays reachable by its own module path.
 */
export { httpStatus, isPermissionError } from "./errors.js";
export { createTokenClient, type GithubTokenConfig } from "./token.js";
export {
  type AnnotationLevel,
  type ChangedFile,
  type CheckRun,
  type CheckRunAnnotation,
  type CheckRunConclusion,
  type CheckRunOutput,
  type CodeSearchMatch,
  type CreateCheckRunInput,
  type CreateReviewInput,
  type ExistingReviewComment,
  type FileContentsRequest,
  type GithubInstallationClient,
  type PullRequestDetails,
  type PullRequestRef,
  type PullRequestReview,
  type ReviewComment,
} from "./client.js";
