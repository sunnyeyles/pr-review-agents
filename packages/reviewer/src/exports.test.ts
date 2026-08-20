/**
 * Barrel guard for @pr-review/reviewer. See the note in
 * packages/ai/src/exports.test.ts: runtime keys cover value exports,
 * the type tuple hands the same job to `tsc --noEmit`.
 */
import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import type {
  AgentFailure,
  PublishReview,
  RenderedCheckRun,
  ReviewPipelineResult,
  ReviewPullRequestDeps,
  ReviewTarget,
  SynthesisResult,
  Synthesiser,
  SynthesiserDeps,
} from "./index.js";

const DOCUMENTED_EXPORTS = [
  "SYNTHESIS_SYSTEM_PROMPT",
  "SynthesisError",
  "createCheckRunPublisher",
  "createSynthesiser",
  "renderCheckRun",
  "reviewCorrelation",
  "reviewPullRequest",
  "runReviewPipeline",
  "validateFindings",
] as const;

type DocumentedTypes = [
  AgentFailure,
  PublishReview,
  RenderedCheckRun,
  ReviewPipelineResult,
  ReviewPullRequestDeps,
  ReviewTarget,
  SynthesisResult,
  Synthesiser,
  SynthesiserDeps,
];

describe("@pr-review/reviewer public entry point", () => {
  it("exports exactly its documented symbol set", () => {
    expect(Object.keys(barrel).sort()).toEqual([...DOCUMENTED_EXPORTS]);
  });

  it("exports every documented type (enforced by typecheck)", () => {
    const documented: DocumentedTypes[] = [];
    expect(documented).toHaveLength(0);
  });
});
