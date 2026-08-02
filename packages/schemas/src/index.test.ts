import { describe, expect, it } from "vitest";

import { SCHEMAS_PACKAGE } from "./index.js";

describe("@pr-review/schemas", () => {
  it("exports the package marker", () => {
    expect(SCHEMAS_PACKAGE).toBe("@pr-review/schemas");
  });
});
