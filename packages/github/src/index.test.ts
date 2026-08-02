import { describe, expect, it } from "vitest";

import { GITHUB_PACKAGE, githubPackageDependencies } from "./index.js";

describe("@pr-review/github", () => {
  it("exports the package marker", () => {
    expect(GITHUB_PACKAGE).toBe("@pr-review/github");
  });

  it("imports from @pr-review/schemas", () => {
    expect(githubPackageDependencies).toContain("@pr-review/schemas");
  });
});
