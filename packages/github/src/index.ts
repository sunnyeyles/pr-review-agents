/**
 * @pr-review/github
 *
 * GitHub App authentication, Octokit client, and read-only PR tools.
 * Populated in later tickets; this placeholder only wires the package
 * into the workspace.
 */
import { SCHEMAS_PACKAGE } from "@pr-review/schemas";

export const GITHUB_PACKAGE = "@pr-review/github";

export const githubPackageDependencies = [SCHEMAS_PACKAGE] as const;
