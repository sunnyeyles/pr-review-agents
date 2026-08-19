import { describe, expect, it } from "vitest";

import { HttpError } from "./errors.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  parsePagination,
} from "./pagination.js";

describe("parsePagination", () => {
  it("defaults to the first page", () => {
    expect(parsePagination({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      offset: 0,
    });
  });

  it("computes the offset from the page and page size", () => {
    expect(parsePagination({ page: "3", pageSize: "20" })).toEqual({
      page: 3,
      pageSize: 20,
      offset: 40,
    });
  });

  it("rejects values that are not positive integers", () => {
    for (const page of ["0", "-1", "1.5", "", "one", "1e3"]) {
      expect(() => parsePagination({ page })).toThrow(HttpError);
    }
  });

  it("rejects a page size above the maximum", () => {
    expect(() => parsePagination({ pageSize: String(MAX_PAGE_SIZE + 1) })).toThrow(
      HttpError,
    );
  });

  it("rejects a page above the maximum", () => {
    expect(() => parsePagination({ page: String(MAX_PAGE + 1) })).toThrow(HttpError);
  });

  it("rejects a repeated parameter", () => {
    expect(() => parsePagination({ page: ["1", "2"] })).toThrow(HttpError);
  });

  it("answers 400 for invalid input", () => {
    try {
      parsePagination({ page: "0" });
      expect.unreachable("expected parsePagination to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
    }
  });
});
