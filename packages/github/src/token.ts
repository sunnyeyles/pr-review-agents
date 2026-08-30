/**
 * Token-authenticated GitHub client: the workflow token is the whole
 * credential. Its permissions come from the workflow's `permissions:`
 * block — reads need `contents`/`pull-requests`, the check run needs
 * `checks: write`, which a fork workflow's read-only token lacks.
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
