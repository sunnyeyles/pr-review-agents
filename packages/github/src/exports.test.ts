/**
 * Barrel guard for @pr-review/github. See the note in
 * packages/ai/src/exports.test.ts: runtime keys cover value exports,
 * the type tuple hands the same job to `tsc --noEmit`.
 */
import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import type {
  AnnotationLevel,
  ChangedFile,
  CheckRun,
  CheckRunAnnotation,
  CheckRunConclusion,
  CheckRunOutput,
  CodeSearchMatch,
  CodeSearchRequest,
  CreateCheckRunInput,
  FileContentsRequest,
  GithubInstallationClient,
  GithubTokenConfig,
  OctokitLike,
  PullRequestDetails,
  PullRequestRef,
} from "./index.js";

const DOCUMENTED_EXPORTS = [
  "CHECK_RUN_NAME",
  "createInstallationClient",
  "createTokenClient",
] as const;

type DocumentedTypes = [
  AnnotationLevel,
  ChangedFile,
  CheckRun,
  CheckRunAnnotation,
  CheckRunConclusion,
  CheckRunOutput,
  CodeSearchMatch,
  CodeSearchRequest,
  CreateCheckRunInput,
  FileContentsRequest,
  GithubInstallationClient,
  GithubTokenConfig,
  OctokitLike,
  PullRequestDetails,
  PullRequestRef,
];

describe("@pr-review/github public entry point", () => {
  it("exports exactly its documented symbol set", () => {
    expect(Object.keys(barrel).sort()).toEqual([...DOCUMENTED_EXPORTS]);
  });

  it("exports every documented type (enforced by typecheck)", () => {
    const documented: DocumentedTypes[] = [];
    expect(documented).toHaveLength(0);
  });
});
