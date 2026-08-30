/**
 * The evaluation harness's own tests: the same pipeline the evaluations
 * drive, with the model boundary filled by scripted fakes so it can run
 * in CI. Findings are planted where a good reviewer would put them, and
 * where a bad one would.
 */
import {
  createReviewAgent,
  reviewLenses,
  type ReviewAgent,
} from "@pr-review/ai";
import type { ChangedFile, GithubInstallationClient } from "@pr-review/github";
import { createCapturingLogger } from "@pr-review/logging";
import { createSynthesiser, validateFindings } from "@pr-review/reviewer";
import type { FindingCategory, ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import {
  finalFindingsJson,
  makeAnthropic,
  makeFinding,
  message,
  textBlock,
} from "../../packages/ai/src/agent-test-support.js";
import { evalCases } from "./cases.js";
import {
  evaluateExpectation,
  resolveAnchor,
  type FixtureExpectation,
} from "./expectations.js";
import { createFixtureClient } from "./fixture-client.js";
import {
  listFixtureNames,
  loadFixture,
  type LoadedFixture,
} from "./fixture.js";
import {
  API_KEY_ENV,
  DEFAULT_MODEL,
  MODEL_ENV,
  requireModelAccess,
} from "./model-access.js";
import {
  runFixtureReview,
  type FixtureReviewDeps,
} from "./run-fixture-review.js";
import { buildPatch, diffOps, toLines } from "./unified-diff.js";

const MODEL = "harness-test-model";

/** The line number of the first line containing `marker`. */
function lineOf(contents: string, marker: string): number {
  const index = contents.split("\n").findIndex((line) => line.includes(marker));
  expect(index, `marker "${marker}" not found`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

/** One fixture file's head contents, or a clear failure. */
function headFile(fixture: LoadedFixture, path: string): string {
  const contents = fixture.headFiles.get(path);
  if (contents === undefined) {
    throw new Error(`fixture ${fixture.name} has no ${path}`);
  }
  return contents;
}

/** One changed file of a fixture's pull request, or a clear failure. */
function changedFile(fixture: LoadedFixture, path: string): ChangedFile {
  const file = fixture.changedFiles.find((candidate) => candidate.filename === path);
  if (file === undefined) {
    throw new Error(`fixture ${fixture.name}'s pull request does not change ${path}`);
  }
  return file;
}

/** The expectations the evaluation suite declares for one fixture. */
function expectationsFor(fixtureName: string): FixtureExpectation[] {
  const evalCase = evalCases.find((candidate) => candidate.fixture === fixtureName);
  if (evalCase === undefined) {
    throw new Error(`no evaluation case for fixture ${fixtureName}`);
  }
  return evalCase.expectations;
}

/** The single "finding" expectation of one fixture. */
function findingExpectationFor(fixtureName: string): FixtureExpectation {
  const expectation = expectationsFor(fixtureName).find(
    (candidate) => candidate.kind === "finding",
  );
  if (expectation === undefined) {
    throw new Error(`fixture ${fixtureName} declares no finding expectation`);
  }
  return expectation;
}

/** Real agents and Synthesiser, with only the Anthropic client scripted. */
function scriptedDeps(
  byCategory: Partial<Record<FindingCategory, ReviewFinding[]>>,
): FixtureReviewDeps {
  const synthesised = Object.values(byCategory).flat();
  return {
    createAgents: (github: GithubInstallationClient): ReviewAgent[] =>
      reviewLenses.map((lens) =>
        createReviewAgent(lens, {
          anthropic: makeAnthropic([
            message(
              [textBlock(finalFindingsJson(byCategory[lens.category] ?? []))],
              "end_turn",
            ),
          ]).anthropic,
          model: MODEL,
          github,
          logger: createCapturingLogger().logger,
        }),
      ),
    synthesiser: createSynthesiser({
      anthropic: makeAnthropic([
        message([textBlock(finalFindingsJson(synthesised))], "end_turn"),
      ]).anthropic,
      model: MODEL,
    }),
  };
}

describe("fixtures", () => {
  it("loads every fixture the evaluation suite names", () => {
    const onDisk = listFixtureNames();
    expect(onDisk).toEqual(evalCases.map((evalCase) => evalCase.fixture).sort());
    for (const name of onDisk) {
      const fixture = loadFixture(name);
      expect(fixture.changedFiles.length).toBeGreaterThan(0);
      expect(fixture.diff).toContain("diff --git");
    }
  });

  it("anchors every expectation to exactly one line of a changed file", () => {
    for (const evalCase of evalCases) {
      const fixture = loadFixture(evalCase.fixture);
      for (const expectation of evalCase.expectations) {
        if (expectation.kind !== "finding") {
          continue;
        }
        for (const anchor of expectation.anchors) {
          const resolved = resolveAnchor(fixture, anchor);
          expect(resolved.to).toBeGreaterThanOrEqual(resolved.from);
        }
      }
    }
  });

  it("serves added files at the head SHA and not at the base SHA", async () => {
    const fixture = loadFixture("security-tenant-scope");
    const { client } = createFixtureClient(fixture);
    const scope = {
      owner: fixture.context.owner,
      repo: fixture.context.repo,
      path: "src/routes/customer-detail.ts",
    };

    await expect(
      client.getFileContents({ ...scope, ref: fixture.pullRequest.headSha }),
    ).resolves.toContain("findCustomerById");
    await expect(
      client.getFileContents({ ...scope, ref: fixture.pullRequest.baseSha }),
    ).rejects.toThrow(/Not Found/);
  });

  it("serves a modified file's previous contents at the base SHA", async () => {
    const fixture = loadFixture("security-tenant-scope");
    const { client } = createFixtureClient(fixture);
    const scope = {
      owner: fixture.context.owner,
      repo: fixture.context.repo,
      path: "src/data/customers.ts",
    };

    const head = await client.getFileContents({
      ...scope,
      ref: fixture.pullRequest.headSha,
    });
    const base = await client.getFileContents({
      ...scope,
      ref: fixture.pullRequest.baseSha,
    });
    expect(head).toContain("findCustomerById");
    expect(base).not.toContain("findCustomerById");
    expect(base).toContain("listCustomers");
  });

  it("searches only the fixture repository, and never publishes", async () => {
    const fixture = loadFixture("security-tenant-scope");
    const { client, calls } = createFixtureClient(fixture);

    const matches = await client.searchCode({
      owner: fixture.context.owner,
      repo: fixture.context.repo,
      query: "findCustomerById",
    });
    expect(matches.map((match) => match.path)).toContain("src/data/customers.ts");
    expect(calls).toEqual([{ method: "searchCode", detail: "findCustomerById" }]);

    await expect(
      client.createCheckRun({
        owner: fixture.context.owner,
        repo: fixture.context.repo,
        headSha: fixture.pullRequest.headSha,
        conclusion: "neutral",
        output: { title: "t", summary: "s" },
      }),
    ).rejects.toThrow(/must never publish/);
  });
});

describe("generated diffs", () => {
  it("marks only the new function's lines as added in a modified file", () => {
    const fixture = loadFixture("security-tenant-scope");
    const contents = headFile(fixture, "src/data/customers.ts");
    const changed = changedFile(fixture, "src/data/customers.ts");

    // Validation only accepts findings on added lines, so the generated
    // patch must place the new function where the head file has it.
    const planted = makeFinding("security", {
      file: "src/data/customers.ts",
      line: lineOf(contents, "where id = $1"),
    });
    const untouched = makeFinding("security", {
      file: "src/data/customers.ts",
      line: lineOf(contents, "and (display_name ilike $2 or email ilike $2)"),
    });

    expect(validateFindings([planted], [changed])).toEqual([planted]);
    expect(validateFindings([untouched], [changed])).toEqual([]);
  });

  it("emits one hunk per changed region rather than one giant hunk", () => {
    // Two edits far apart in the same file, with untouched lines between.
    const changed = changedFile(
      loadFixture("security-tenant-scope"),
      "src/routes/index.ts",
    );
    const hunkHeaders = (changed.patch ?? "")
      .split("\n")
      .filter((line) => line.startsWith("@@"));

    expect(hunkHeaders).toEqual(["@@ -1,6 +1,7 @@", "@@ -7,6 +8,7 @@"]);
    // The untouched lines between them are context, not re-added lines.
    expect(changed.additions).toBe(2);
    expect(changed.deletions).toBe(0);
  });

  it("leaves the untouched lines of a modified file as context", () => {
    const changed = changedFile(
      loadFixture("clean-pagination"),
      "src/routes/deliveries.ts",
    );

    expect(changed.patch).toContain("-  const rawPage = req.query[\"page\"];");
    expect(changed.patch).toContain(
      "+  const { page, pageSize, offset } = parsePagination(req.query);",
    );
    expect(changed.patch).not.toContain(
      "+import type { Request, Response } from \"express\";",
    );
  });

  it("renders an added file as a single whole-file hunk", () => {
    const fixture = loadFixture("clean-pagination");
    const changed = changedFile(fixture, "src/http/pagination.ts");
    const contents = headFile(fixture, "src/http/pagination.ts");
    const lineCount = toLines(contents, "src/http/pagination.ts").length;

    expect(changed.patch?.startsWith(`@@ -0,0 +1,${lineCount} @@`)).toBe(true);
    expect(changed.deletions).toBe(0);
    expect(changed.additions).toBe(lineCount);
  });

  it("keeps unchanged lines out of the added set", () => {
    const ops = diffOps(["a", "b", "c"], ["a", "x", "c"]);
    expect(ops).toEqual([
      { kind: "context", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "x" },
      { kind: "context", text: "c" },
    ]);
    expect(buildPatch("a\nb\nc\n", "a\nx\nc\n", "f.ts")).toBe(
      ["@@ -1,3 +1,3 @@", " a", "-b", "+x", " c"].join("\n"),
    );
  });
});

describe("the full pipeline against a fixture", () => {
  it("passes the correctness fixture when the planted bug is reported", async () => {
    const fixture = loadFixture("correctness-admin-check");
    const contents = headFile(fixture, "src/routes/admin-audit.ts");
    const review = await runFixtureReview(
      fixture,
      scriptedDeps({
        correctness: [
          makeFinding("correctness", {
            file: "src/routes/admin-audit.ts",
            line: lineOf(contents, 'user.role = "admin"'),
            title: "The admin check assigns instead of comparing",
          }),
        ],
      }),
    );

    expect(review.result.agentFailures).toEqual([]);
    expect(review.result.synthesisOutcome).toBe("completed");
    expect(review.rendered.conclusion).toBe("neutral");

    for (const expectation of expectationsFor(fixture.name)) {
      expect(
        evaluateExpectation(review, expectation).passed,
        expectation.description,
      ).toBe(true);
    }
  });

  it("fails the correctness expectation when the finding lands elsewhere", async () => {
    const fixture = loadFixture("correctness-admin-check");
    const contents = headFile(fixture, "src/routes/index.ts");
    const review = await runFixtureReview(
      fixture,
      scriptedDeps({
        // A real finding on a real added line, but not the planted bug.
        correctness: [
          makeFinding("correctness", {
            file: "src/routes/index.ts",
            line: lineOf(contents, 'router.get("/admin/audit-events"'),
          }),
        ],
      }),
    );

    expect(review.result.findings.length).toBe(1);
    const outcome = evaluateExpectation(review, findingExpectationFor(fixture.name));
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("No correctness finding landed");
  });

  it("fails the correctness expectation when the finding is in the wrong category", async () => {
    const fixture = loadFixture("correctness-admin-check");
    const contents = headFile(fixture, "src/routes/admin-audit.ts");
    const line = lineOf(contents, 'user.role = "admin"');
    const review = await runFixtureReview(
      fixture,
      scriptedDeps({
        security: [
          makeFinding("security", { file: "src/routes/admin-audit.ts", line }),
        ],
      }),
    );

    expect(
      evaluateExpectation(review, findingExpectationFor(fixture.name)).passed,
    ).toBe(false);
  });

  it("passes the clean fixture only when the review reports nothing", async () => {
    const fixture = loadFixture("clean-pagination");
    const clean = await runFixtureReview(fixture, scriptedDeps({}));
    expect(clean.result.findings).toEqual([]);
    expect(clean.rendered.conclusion).toBe("success");
    for (const expectation of expectationsFor(fixture.name)) {
      expect(
        evaluateExpectation(clean, expectation).passed,
        expectation.description,
      ).toBe(true);
    }

    // One plausible-sounding false positive is a failure.
    const contents = headFile(fixture, "src/http/pagination.ts");
    const noisy = await runFixtureReview(
      fixture,
      scriptedDeps({
        architecture: [
          makeFinding("architecture", {
            file: "src/http/pagination.ts",
            line: lineOf(contents, "export function parsePagination"),
            title: "Pagination parsing could live in a shared package",
          }),
        ],
      }),
    );
    const outcome = evaluateExpectation(noisy, {
      kind: "no-findings",
      description: "reports no findings",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("false positive");
  });

  it("reports which agents failed rather than counting a degraded review", async () => {
    const fixture = loadFixture("clean-pagination");
    const deps = scriptedDeps({});
    const review = await runFixtureReview(fixture, {
      ...deps,
      createAgents: (github, logger) =>
        deps.createAgents(github, logger).map((agent, index) =>
          index === 0
            ? {
                name: agent.name,
                run: () => Promise.reject(new Error("model overloaded")),
              }
            : agent,
        ),
    });

    const outcome = evaluateExpectation(review, {
      kind: "agents-completed",
      description: "all three review agents complete",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("correctness: model overloaded");
  });
});

describe("model access", () => {
  it("refuses to run without an API key, naming the variable and the command", () => {
    expect(() => requireModelAccess({})).toThrow(API_KEY_ENV);
    expect(() => requireModelAccess({ [API_KEY_ENV]: "  " })).toThrow(
      /pnpm eval/,
    );
  });

  it("defaults the model to the action's default and lets it be overridden", () => {
    expect(requireModelAccess({ [API_KEY_ENV]: "x" }).model).toBe(DEFAULT_MODEL);
    expect(
      requireModelAccess({ [API_KEY_ENV]: "x", [MODEL_ENV]: "other-model" }).model,
    ).toBe("other-model");
  });
});
