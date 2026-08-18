/**
 * Token-authenticated GitHub client.
 *
 * The GitHub Action runs inside the customer's own workflow, which is
 * already handed a scoped installation token (`github.token` /
 * `GITHUB_TOKEN`). There is no App private key to load and no
 * installation to resolve — the token is the credential.
 *
 * The permissions that token carries are set by the workflow's
 * `permissions:` block, not by us: the six read tools need
 * `contents: read` and `pull-requests: read`, and publishing the check
 * run needs `checks: write`. GitHub grants a read-only token to
 * workflows triggered by fork pull requests, so `createCheckRun` can
 * legitimately fail with a permission error on that path; the Action
 * handles that by falling back to the workflow job summary rather than
 * failing the review.
 */
import { Octokit } from "@octokit/rest";

import { createInstallationClient, type OctokitLike } from "./app.js";
import type { GithubInstallationClient } from "./client.js";

export interface GithubTokenConfig {
  /** A GitHub token — in Actions, `${{ github.token }}`. */
  token: string;
  /** Injectable Octokit factory; defaults to a real token-authenticated Octokit. */
  createOctokit?: ((token: string) => OctokitLike) | undefined;
}

/**
 * Builds the read-only PR client from a plain token. Returns the same
 * GithubInstallationClient interface the App path produces, so the
 * review pipeline cannot tell the two apart.
 */
export function createTokenClient(
  config: GithubTokenConfig,
): GithubInstallationClient {
  const createOctokit =
    config.createOctokit ?? ((token: string) => new Octokit({ auth: token }));
  return createInstallationClient(createOctokit(config.token));
}
