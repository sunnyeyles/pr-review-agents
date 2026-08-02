/**
 * @pr-review/github
 *
 * GitHub App authentication, Octokit client, and read-only PR tools:
 * installation-authenticated clients that load PR details, changed
 * files, and diffs, and publish the "AI PR Review" check run.
 */
import { SCHEMAS_PACKAGE } from "@pr-review/schemas";

export const GITHUB_PACKAGE = "@pr-review/github";

export const githubPackageDependencies = [SCHEMAS_PACKAGE] as const;

export {
  createGithubApp,
  type GithubAppConfig,
  type OctokitLike,
} from "./app.js";
export {
  CHECK_RUN_NAME,
  type ChangedFile,
  type CheckRun,
  type CheckRunConclusion,
  type CheckRunOutput,
  type CreateCheckRunInput,
  type GithubInstallationClient,
  type InstallationClientFactory,
  type PullRequestDetails,
  type PullRequestRef,
} from "./client.js";
