/**
 * The agent evaluation suite: is the review any good? Each fixture is a
 * real pull request run through the real pipeline with the real model.
 * These call the model, cost tokens, and are non-deterministic, so they
 * live outside `pnpm test` and run on demand with `pnpm eval`.
 */
import process from "node:process";

import { resolveReviewLenses } from "@pr-review/ai";
import { createConsoleLogger } from "@pr-review/logging";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { evalCases } from "./cases.js";
import { evaluateExpectation } from "./expectations.js";
import { loadFixture } from "./fixture.js";
import { AGENTS_ENV, requireModelAccess } from "./model-access.js";
import { formatReviewReport, formatRunReport } from "./report.js";
import {
  modelBackedDeps,
  runFixtureReview,
  type FixtureReview,
} from "./run-fixture-review.js";

// The console logger tees lifecycle events to the terminal as they
// happen: a full review takes minutes, and silence looks like a hang.
const deps = modelBackedDeps(
  requireModelAccess(process.env),
  createConsoleLogger(),
  resolveReviewLenses(process.env[AGENTS_ENV] ?? ""),
);

const reports: string[] = [];

for (const evalCase of evalCases) {
  const fixture = loadFixture(evalCase.fixture);

  describe(`${fixture.name} — ${fixture.title}`, () => {
    let review: FixtureReview;

    beforeAll(async () => {
      review = await runFixtureReview(fixture, deps);
      reports.push(formatReviewReport(review));
    });

    for (const expectation of evalCase.expectations) {
      test(expectation.description, () => {
        const outcome = evaluateExpectation(review, expectation);
        expect(
          outcome.passed,
          `FIXTURE ${fixture.name}\nEXPECTATION ${expectation.description}\n\n${outcome.detail}`,
        ).toBe(true);
      });
    }
  });
}

afterAll(() => {
  if (reports.length > 0) {
    console.log(formatRunReport(reports));
  }
});
