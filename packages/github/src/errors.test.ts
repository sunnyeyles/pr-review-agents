import { describe, expect, it } from "vitest";

import { httpStatus, isPermissionError } from "./errors.js";

/** An Octokit RequestError carries the HTTP status on `.status`. */
function requestError(status: number, message = "request failed"): Error {
  return Object.assign(new Error(message), { status, name: "HttpError" });
}

describe("httpStatus", () => {
  it("reads the status off an Octokit request error", () => {
    expect(httpStatus(requestError(403))).toBe(403);
  });

  it("returns undefined for errors without a numeric status", () => {
    expect(httpStatus(new Error("boom"))).toBeUndefined();
    expect(httpStatus({ status: "403" })).toBeUndefined();
    expect(httpStatus(null)).toBeUndefined();
    expect(httpStatus(undefined)).toBeUndefined();
  });
});

describe("isPermissionError", () => {
  it("treats 403 as a missing checks: write scope", () => {
    expect(
      isPermissionError(requestError(403, "Resource not accessible by integration")),
    ).toBe(true);
  });

  it("treats 404 as a hidden resource, which a read-only token produces", () => {
    expect(isPermissionError(requestError(404, "Not Found"))).toBe(true);
  });

  it("does not treat an invalid or expired token as a fork", () => {
    expect(isPermissionError(requestError(401, "Bad credentials"))).toBe(false);
  });

  it("does not treat server errors as permission problems", () => {
    expect(isPermissionError(requestError(500))).toBe(false);
    expect(isPermissionError(requestError(502))).toBe(false);
  });

  it("does not treat a rate limit as a permission problem", () => {
    expect(isPermissionError(requestError(429, "rate limit exceeded"))).toBe(false);
  });

  it("does not treat network failures as permission problems", () => {
    expect(isPermissionError(new Error("ECONNRESET"))).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
  });
});
