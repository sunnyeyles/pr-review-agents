import { describe, expect, it } from "vitest";

import { WEBHOOK_APP, webhookAppDependencies } from "./index.js";

describe("@pr-review/webhook", () => {
  it("exports the app marker", () => {
    expect(WEBHOOK_APP).toBe("@pr-review/webhook");
  });

  it("imports from the schemas and github packages", () => {
    expect(webhookAppDependencies).toEqual([
      "@pr-review/schemas",
      "@pr-review/github",
    ]);
  });
});
