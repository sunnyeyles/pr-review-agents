/**
 * The agent evaluation suite (spec §27, ticket 15).
 *
 * Every other test in this repository proves the plumbing works —
 * that agents fan out, that a failed agent degrades into a partial
 * review, that validation drops findings naming files the pull request
 * never touched. This file asks the only question those cannot: is the
 * review any GOOD? Each fixture is a real pull request against a real
 * (small) repository, run through the real pipeline with the real
 * model, and judged on what it reported.
 *
 * These are not unit tests. They call the model, they cost tokens,
 * and they are non-deterministic — a run is evidence about review
 * quality, not a proof. They live outside `pnpm test` (this file's
 * `.eval.ts` extension keeps it out of every unit project's `include`)
 * and run on demand with `pnpm eval`.
 */
import process from "node:process";

import { createConsoleLogger } from "@pr-review/logging";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { evalCases } from "./cases.js";
import { evaluateExpectation } from "./expectations.js";
import { loadFixture } from "./fixture.js";
import { requireModelAccess } from "./model-access.js";
import { formatReviewReport, formatRunReport } from "./report.js";
import {
  modelBackedDeps,
  runFixtureReview,
  type FixtureReview,
} from "./run-fixture-review.js";

// Already checked by the global setup; read here for the actual run so
// the key never lives anywhere but this process's environment.
// The console logger tees the lifecycle events (spec §26) to the
// terminal as they happen: a full review takes minutes, and a silent
// terminal is indistinguishable from a hung one.
const deps = modelBackedDeps(requireModelAccess(process.env), createConsoleLogger());

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
        // The assertion message names the fixture and the expectation,
        // then shows what the reviewer actually reported.
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
