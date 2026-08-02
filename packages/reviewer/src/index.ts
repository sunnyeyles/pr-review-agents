/**
 * @pr-review/reviewer
 *
 * Orchestrator, review agents (correctness, security, architecture),
 * and synthesiser. Populated in later tickets; this placeholder only
 * wires the package into the workspace.
 */
import { AI_PACKAGE } from "@pr-review/ai";
import { GITHUB_PACKAGE } from "@pr-review/github";
import { SCHEMAS_PACKAGE } from "@pr-review/schemas";

export const REVIEWER_PACKAGE = "@pr-review/reviewer";

export const reviewerPackageDependencies = [
  SCHEMAS_PACKAGE,
  GITHUB_PACKAGE,
  AI_PACKAGE,
] as const;
