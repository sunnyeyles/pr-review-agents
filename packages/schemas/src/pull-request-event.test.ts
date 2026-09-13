/**
 * The review trigger contract: which pull_request actions start a review.
 * The payload schema lives with apps/action/src/event.ts.
 */
import { describe, expect, it } from "vitest";

import {
  isLearnPullRequestAction,
  isSupportedPullRequestAction,
} from "./pull-request-event.js";

describe("isSupportedPullRequestAction", () => {
  it.each(["opened", "synchronize", "reopened"])(
    "triggers a review for %s",
    (action) => {
      expect(isSupportedPullRequestAction(action)).toBe(true);
    },
  );

  it.each([
    "closed",
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
    "edited",
    "ready_for_review",
    "converted_to_draft",
    "review_requested",
    "auto_merge_enabled",
  ])("ignores %s", (action) => {
    expect(isSupportedPullRequestAction(action)).toBe(false);
  });

  it("ignores an empty action", () => {
    expect(isSupportedPullRequestAction("")).toBe(false);
  });

  it("matches exactly: casing and surrounding whitespace are not normalised", () => {
    expect(isSupportedPullRequestAction("Opened")).toBe(false);
    expect(isSupportedPullRequestAction("OPENED")).toBe(false);
    expect(isSupportedPullRequestAction(" opened ")).toBe(false);
  });

  it("does not inherit Object.prototype members as actions", () => {
    expect(isSupportedPullRequestAction("toString")).toBe(false);
    expect(isSupportedPullRequestAction("constructor")).toBe(false);
  });
});

describe("isLearnPullRequestAction", () => {
  it("learns from closed, the only action carrying final outcomes", () => {
    expect(isLearnPullRequestAction("closed")).toBe(true);
  });

  it.each(["opened", "synchronize", "reopened", "labeled", "edited", ""])(
    "ignores %o",
    (action) => {
      expect(isLearnPullRequestAction(action)).toBe(false);
    },
  );

  it("matches exactly and inherits no Object.prototype members", () => {
    expect(isLearnPullRequestAction("Closed")).toBe(false);
    expect(isLearnPullRequestAction(" closed ")).toBe(false);
    expect(isLearnPullRequestAction("toString")).toBe(false);
  });
});

describe("the two trigger lists", () => {
  it("never claim the same action", () => {
    for (const action of ["opened", "synchronize", "reopened", "closed"]) {
      expect(
        isSupportedPullRequestAction(action) && isLearnPullRequestAction(action),
      ).toBe(false);
    }
  });
});
