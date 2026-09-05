/**
 * Token-authenticated GitHub client. Permissions come from the workflow's
 * `permissions:` block, which a fork's read-only token cannot satisfy.
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

/** Nothing downstream depends on how the Octokit behind this was authenticated. */
export function createTokenClient(
  config: GithubTokenConfig,
): GithubInstallationClient {
  const createOctokit =
    config.createOctokit ?? ((token: string) => new Octokit({ auth: token }));
  return createInstallationClient(createOctokit(config.token));
}
