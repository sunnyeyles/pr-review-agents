/**
 * @pr-review/schemas
 *
 * Shared Zod schemas and types for review jobs and findings.
 */
export const SCHEMAS_PACKAGE = "@pr-review/schemas";

export { reviewJobSchema, type ReviewJob } from "./review-job.js";
export {
  reviewFindingSchema,
  type FindingCategory,
  type FindingSeverity,
  type ReviewFinding,
} from "./review-finding.js";
