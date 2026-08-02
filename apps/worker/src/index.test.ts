import { describe, expect, it } from "vitest";

import { WORKER_APP, workerAppDependencies } from "./index.js";

describe("@pr-review/worker", () => {
  it("exports the app marker", () => {
    expect(WORKER_APP).toBe("@pr-review/worker");
  });

  it("imports from all four shared packages", () => {
    expect(workerAppDependencies).toEqual([
      "@pr-review/schemas",
      "@pr-review/github",
      "@pr-review/ai",
      "@pr-review/reviewer",
    ]);
  });
});
