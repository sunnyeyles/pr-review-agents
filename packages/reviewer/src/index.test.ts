import { describe, expect, it } from "vitest";

import { REVIEWER_PACKAGE, reviewerPackageDependencies } from "./index.js";

describe("@pr-review/reviewer", () => {
  it("exports the package marker", () => {
    expect(REVIEWER_PACKAGE).toBe("@pr-review/reviewer");
  });

  it("imports from the schemas, github, and ai packages", () => {
    expect(reviewerPackageDependencies).toEqual([
      "@pr-review/schemas",
      "@pr-review/github",
      "@pr-review/ai",
    ]);
  });
});
