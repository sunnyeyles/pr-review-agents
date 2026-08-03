import { describe, expect, it } from "vitest";

import { AI_PACKAGE, aiPackageDependencies } from "./index.js";

describe("@pr-review/ai", () => {
  it("exports the package marker", () => {
    expect(AI_PACKAGE).toBe("@pr-review/ai");
  });

  it("imports from the schemas, github, and logging packages", () => {
    expect(aiPackageDependencies).toEqual([
      "@pr-review/schemas",
      "@pr-review/github",
      "@pr-review/logging",
    ]);
  });
});
