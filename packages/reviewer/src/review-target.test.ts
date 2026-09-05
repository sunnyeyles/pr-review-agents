import { describe, expect, it } from "vitest";

import { reviewCorrelation, type ReviewTarget } from "./review-target.js";

const target: ReviewTarget = {
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

describe("reviewCorrelation", () => {
  it("carries repository, PR number, and head SHA (spec §26)", () => {
    expect(reviewCorrelation(target)).toEqual({
      repository: "octo-org/example-service",
      pullRequestNumber: 42,
      headSha: target.headSha,
    });
  });
});
