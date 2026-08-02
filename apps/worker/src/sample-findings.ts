/**
 * PLACEHOLDER — hard-coded sample findings standing in for the AI
 * review agents until the agent tickets (06–08) land. The worker feeds
 * this list through the deterministic validation chain exactly as it
 * will feed real agent output later.
 *
 * The samples deliberately exercise the chain: one schema-invalid, one
 * referencing a file outside the PR, one below the confidence
 * threshold, one valid line-anchored, and one valid file-level. On a
 * real pull request none of them reference actually-changed files, so
 * every sample is dropped and the published check run reports a clean
 * "no issues found" result — no fabricated findings ever reach a real
 * PR.
 */
import type { ReviewFinding } from "@pr-review/schemas";

/**
 * Survives the chain when the PR contains this file with line 42 as an
 * added line; renders as an inline annotation.
 */
export const sampleValidLineFinding: ReviewFinding = {
  file: "src/sample/session-service.ts",
  line: 42,
  category: "security",
  severity: "high",
  title: "Missing tenant validation on session lookup",
  explanation:
    "The session is loaded by id without checking that it belongs to the requesting tenant, allowing cross-tenant access.",
  suggestedFix: "Filter the session query by the authenticated tenant id.",
  confidence: 0.9,
};

/**
 * Survives the chain when the PR contains this file; has no line, so it
 * appears in the summary but not as an annotation.
 */
export const sampleFileLevelFinding: ReviewFinding = {
  file: "src/sample/session-service.ts",
  category: "architecture",
  severity: "medium",
  title: "Session expiry rules implemented in the HTTP layer",
  explanation:
    "Session expiry policy lives in the request handler instead of the session domain module, duplicating logic the domain layer already owns.",
  confidence: 0.8,
};

/** Dropped: references a file that is not part of the pull request. */
export const sampleWrongFileFinding: ReviewFinding = {
  file: "src/not-part-of-this-pr.ts",
  line: 7,
  category: "correctness",
  severity: "high",
  title: "Error swallowed in catch block",
  explanation:
    "The catch block returns an empty result instead of propagating the failure.",
  confidence: 0.95,
};

/** Dropped: confidence is below the 0.70 threshold. */
export const sampleLowConfidenceFinding: ReviewFinding = {
  file: "src/sample/session-service.ts",
  line: 43,
  category: "correctness",
  severity: "low",
  title: "Possible off-by-one in session TTL comparison",
  explanation:
    "The TTL comparison may exclude the final second of a session's validity window.",
  confidence: 0.4,
};

/** Dropped by Zod: confidence is outside the allowed 0..1 range. */
export const sampleSchemaInvalidFinding: unknown = {
  file: "src/sample/session-service.ts",
  category: "security",
  severity: "high",
  title: "Malformed sample with out-of-range confidence",
  explanation: "This candidate must be rejected by schema validation.",
  confidence: 1.5,
};

/** The full placeholder list the worker feeds through the pipeline. */
export const sampleFindings: readonly unknown[] = [
  sampleSchemaInvalidFinding,
  sampleWrongFileFinding,
  sampleLowConfidenceFinding,
  sampleValidLineFinding,
  sampleFileLevelFinding,
];
