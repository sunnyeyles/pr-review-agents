import { describe, expect, it } from "vitest";

import { reviewJobSchema, type ReviewJob } from "./index.js";

const validJob: ReviewJob = {
  installationId: 12345678,
  owner: "octo-org",
  repo: "example-service",
  pullRequestNumber: 42,
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
};

describe("reviewJobSchema", () => {
  it("accepts a valid review job", () => {
    const result = reviewJobSchema.safeParse(validJob);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validJob);
    }
  });

  it("rejects a job with a missing field", () => {
    const { headSha: _headSha, ...withoutSha } = validJob;
    expect(reviewJobSchema.safeParse(withoutSha).success).toBe(false);
  });

  it("rejects a non-integer installation id", () => {
    expect(
      reviewJobSchema.safeParse({ ...validJob, installationId: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects a non-positive pull request number", () => {
    expect(
      reviewJobSchema.safeParse({ ...validJob, pullRequestNumber: 0 }).success,
    ).toBe(false);
  });

  it("rejects an empty owner or repo", () => {
    expect(reviewJobSchema.safeParse({ ...validJob, owner: "" }).success).toBe(
      false,
    );
    expect(reviewJobSchema.safeParse({ ...validJob, repo: "" }).success).toBe(
      false,
    );
  });

  it("rejects a head SHA that is not a 40-character hex string", () => {
    expect(
      reviewJobSchema.safeParse({ ...validJob, headSha: "main" }).success,
    ).toBe(false);
    expect(
      reviewJobSchema.safeParse({ ...validJob, headSha: "" }).success,
    ).toBe(false);
  });

  it("strips unknown fields rather than passing them through", () => {
    const result = reviewJobSchema.safeParse({ ...validJob, extra: "field" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validJob);
    }
  });

  it("rejects non-object input", () => {
    expect(reviewJobSchema.safeParse("not a job").success).toBe(false);
    expect(reviewJobSchema.safeParse(null).success).toBe(false);
  });
});
