/**
 * @pr-review/ai
 *
 * Anthropic SDK client and model configuration.
 * Populated in later tickets; this placeholder only wires the package
 * into the workspace.
 */
import { SCHEMAS_PACKAGE } from "@pr-review/schemas";

export const AI_PACKAGE = "@pr-review/ai";

export const aiPackageDependencies = [SCHEMAS_PACKAGE] as const;
