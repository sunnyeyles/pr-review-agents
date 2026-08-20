/**
 * Barrel guard for @pr-review/logging. See the note in
 * packages/ai/src/exports.test.ts: runtime keys cover value exports,
 * the type tuple hands the same job to `tsc --noEmit`.
 */
import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import type {
  CapturedLogEvent,
  CapturingLogger,
  LogFields,
  LogLevel,
  StructuredLogger,
} from "./index.js";

const DOCUMENTED_EXPORTS = [
  "createCapturingLogger",
  "createConsoleLogger",
  "errorMessage",
  "errorName",
] as const;

type DocumentedTypes = [
  CapturedLogEvent,
  CapturingLogger,
  LogFields,
  LogLevel,
  StructuredLogger,
];

describe("@pr-review/logging public entry point", () => {
  it("exports exactly its documented symbol set", () => {
    expect(Object.keys(barrel).sort()).toEqual([...DOCUMENTED_EXPORTS]);
  });

  it("exports every documented type (enforced by typecheck)", () => {
    const documented: DocumentedTypes[] = [];
    expect(documented).toHaveLength(0);
  });
});
