/**
 * Barrel guard for @pr-review/schemas. See the note in
 * packages/ai/src/exports.test.ts: runtime keys cover value exports,
 * the type tuple hands the same job to `tsc --noEmit`.
 */
import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import type {
  FindingCategory,
  FindingSeverity,
  ReviewFinding,
  SupportedPullRequestAction,
} from "./index.js";

const DOCUMENTED_EXPORTS = [
  "isSupportedPullRequestAction",
  "reviewFindingSchema",
] as const;

type DocumentedTypes = [
  FindingCategory,
  FindingSeverity,
  ReviewFinding,
  SupportedPullRequestAction,
];

describe("@pr-review/schemas public entry point", () => {
  it("exports exactly its documented symbol set", () => {
    expect(Object.keys(barrel).sort()).toEqual([...DOCUMENTED_EXPORTS]);
  });

  it("exports every documented type (enforced by typecheck)", () => {
    const documented: DocumentedTypes[] = [];
    expect(documented).toHaveLength(0);
  });
});
