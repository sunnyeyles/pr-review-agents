import { describe, expect, it } from "vitest";

import { inspectEvent } from "./event.js";

const headSha = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
const baseSha = "a3f1c0d9e2b4867501fedcba9876543210abcdef";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: { name: "example-service", owner: { login: "octo-org" } },
    pull_request: {
      number: 42,
      base: { sha: baseSha },
      head: { sha: headSha, repo: { full_name: "octo-org/example-service" } },
    },
    ...overrides,
  };
}

describe("inspectEvent", () => {
  it("returns the review target for a supported pull_request action", () => {
    expect(inspectEvent(payload(), "pull_request")).toEqual({
      review: true,
      isFork: false,
      baseSha,
      target: {
        owner: "octo-org",
        repo: "example-service",
        pullRequestNumber: 42,
        headSha,
      },
    });
  });

  it("rejects a base SHA that is not a full commit SHA", () => {
    // The agent configuration is read at this commit; a ref that is not a
    // pinned SHA could resolve to the branch under review.
    expect(() =>
      inspectEvent(
        payload({
          pull_request: {
            number: 42,
            base: { sha: "main" },
            head: { sha: headSha },
          },
        }),
        "pull_request",
      ),
    ).toThrow(/failed schema validation/);
  });

  it.each(["opened", "synchronize", "reopened"])(
    "reviews the %s action",
    (action) => {
      const inspection = inspectEvent(payload({ action }), "pull_request");
      expect(inspection.review).toBe(true);
    },
  );

  it.each(["closed", "labeled", "assigned", "edited"])(
    "ignores the %s action without failing",
    (action) => {
      expect(inspectEvent(payload({ action }), "pull_request")).toEqual({
        review: false,
        reason: `action ignored: ${action}`,
      });
    },
  );

  it("ignores events that are not pull requests", () => {
    expect(inspectEvent(payload(), "push")).toEqual({
      review: false,
      reason: "unsupported event: push",
    });
  });

  it("accepts pull_request_target, which repositories opt into for fork coverage", () => {
    const inspection = inspectEvent(payload(), "pull_request_target");
    expect(inspection.review).toBe(true);
  });

  it("flags a head branch from another repository as a fork", () => {
    const inspection = inspectEvent(
      payload({
        pull_request: {
          number: 42,
          base: { sha: baseSha },
          head: { sha: headSha, repo: { full_name: "contributor/example-service" } },
        },
      }),
      "pull_request",
    );
    expect(inspection).toMatchObject({ review: true, isFork: true });
  });

  it("still reviews when the head repository is absent", () => {
    const inspection = inspectEvent(
      payload({
        pull_request: {
          number: 42,
          base: { sha: baseSha },
          head: { sha: headSha, repo: null },
        },
      }),
      "pull_request",
    );
    // A null head.repo (a deleted fork) leaves the origin unknown.
    // isFork is a logging field only — the publisher reacts to the real
    // permission error — so an unknown origin reports false rather than
    // failing the review.
    expect(inspection).toMatchObject({ review: true, isFork: false });
  });

  it("throws on a supported action whose payload is malformed", () => {
    expect(() =>
      inspectEvent({ action: "opened", repository: {} }, "pull_request"),
    ).toThrow(/failed schema validation/);
  });

  it("throws on a payload with no action at all", () => {
    expect(() => inspectEvent({}, "pull_request")).toThrow(/no action field/);
  });

  it("rejects a head SHA that is not a full commit SHA", () => {
    expect(() =>
      inspectEvent(
        payload({
          pull_request: { number: 42, base: { sha: baseSha }, head: { sha: "abc1234" } },
        }),
        "pull_request",
      ),
    ).toThrow(/failed schema validation/);
  });
});
