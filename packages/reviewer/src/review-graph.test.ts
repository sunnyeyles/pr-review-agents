import type { ReviewAgent, ReviewContext } from "@pr-review/ai";
import type { ChangedFile } from "@pr-review/github";
import type { ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import { buildReviewGraph, runReviewPipeline } from "./review-graph.js";
import type { Synthesiser } from "./synthesiser.js";

const changedFiles: ChangedFile[] = [
  {
    filename: "src/sessions.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -41,1 +41,2 @@\n context line 41\n+added line 42",
  },
];

const context: ReviewContext = {
  owner: "octo-org",
  repo: "example-service",
  pullRequest: {
    number: 42,
    title: "Add rate limiting",
    body: null,
    state: "open",
    author: "octocat",
    baseRef: "main",
    baseSha: "0000000000000000000000000000000000000000",
    headRef: "feature/rate-limit",
    headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  },
  // The single source of truth for the changed-file list: the agents
  // and the validation node both read it from here.
  changedFiles,
  diff: "",
};

function agent(name: string, run: ReviewAgent["run"]): ReviewAgent {
  return { name, run };
}

/** A pass-through Synthesiser: returns its input verbatim as "findings". */
function passthroughSynthesiser(): Synthesiser {
  return {
    async synthesise(candidates) {
      return { findings: candidates as ReviewFinding[], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

/** A schema-valid candidate finding, overridable per test. */
function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: "src/sessions.ts",
    line: 42,
    category: "correctness",
    severity: "high",
    title: "Assignment instead of comparison in admin check",
    explanation:
      "The if condition assigns true to user.isAdmin instead of comparing, so every user passes the check.",
    confidence: 0.9,
    ...overrides,
  };
}

describe("runReviewPipeline: agent fan-out and partial failure (spec §20)", () => {
  it("runs the agents against the context and validates their candidates", async () => {
    const finding = makeFinding();
    const result = await runReviewPipeline(
      [agent("correctness", async () => [finding])],
      passthroughSynthesiser(),
      context,
    );

    expect(result.candidates).toEqual([finding]);
    expect(result.agentFailures).toEqual([]);
    expect(result.findings).toEqual([finding]);
  });

  it("combines candidates from multiple agents in agent order", async () => {
    const a = makeFinding({ title: "A" });
    const b = makeFinding({ title: "B", line: 43 });
    const result = await runReviewPipeline(
      [
        agent("correctness", async () => [a]),
        agent("security", async () => [b]),
      ],
      passthroughSynthesiser(),
      context,
    );

    expect(result.candidates).toEqual([a, b]);
  });

  it("records a failed agent and still returns the successful agent's candidates", async () => {
    const b = makeFinding({ title: "B" });
    const result = await runReviewPipeline(
      [
        agent("correctness", async () => {
          throw new Error("model unavailable");
        }),
        agent("security", async () => [b]),
      ],
      passthroughSynthesiser(),
      context,
    );

    expect(result.candidates).toEqual([b]);
    expect(result.agentFailures).toEqual([
      { agent: "correctness", error: "model unavailable" },
    ]);
  });

  it("starts every agent node before any of them resolves (real concurrency)", async () => {
    const starts: string[] = [];
    const resolvers: (() => void)[] = [];
    const gated = (name: string) =>
      agent(name, () => {
        starts.push(name);
        return new Promise((resolve) => {
          resolvers.push(() => resolve([makeFinding({ title: name })]));
        });
      });

    const pending = runReviewPipeline(
      [gated("correctness"), gated("security"), gated("architecture")],
      passthroughSynthesiser(),
      context,
    );

    // Give LangGraph's internal scheduling (channel setup, task
    // dispatch — a few microtask hops before any node body runs) a
    // chance to reach every agent node, WITHOUT resolving any of them.
    // A sequential implementation (awaiting one agent before starting
    // the next) would still be stuck on the first agent here, since
    // nothing has been resolved yet — only a true fan-out reaches all
    // three.
    for (let tick = 0; tick < 50 && starts.length < 3; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // LangGraph schedules the fan-out concurrently but does not promise
    // to invoke same-superstep nodes in registration order, so assert
    // set membership here; the RESULT order is still deterministic (see
    // the assertion below), because `join` re-sorts by agent index.
    expect([...starts].sort()).toEqual(["architecture", "correctness", "security"]);

    for (const resolve of resolvers) {
      resolve();
    }
    const result = await pending;
    expect(result.candidates.map((c) => (c as ReviewFinding).title)).toEqual([
      "correctness",
      "security",
      "architecture",
    ]);
    expect(result.agentFailures).toEqual([]);
  });

  it("with one of three agents failing, keeps the other two lenses' candidates, in order", async () => {
    const correctness = makeFinding({ category: "correctness", title: "c" });
    const architecture = makeFinding({ category: "architecture", title: "a" });
    const result = await runReviewPipeline(
      [
        agent("correctness", async () => [correctness]),
        agent("security", async () => {
          throw new Error("model unavailable");
        }),
        agent("architecture", async () => [architecture]),
      ],
      passthroughSynthesiser(),
      context,
    );

    expect(result.candidates).toEqual([correctness, architecture]);
    expect(result.agentFailures).toEqual([
      { agent: "security", error: "model unavailable" },
    ]);
  });

  it("throws when all three agents fail, naming every lens", async () => {
    const failing = (name: string) =>
      agent(name, async () => {
        throw new Error(`${name} exploded`);
      });

    await expect(
      runReviewPipeline(
        [failing("correctness"), failing("security"), failing("architecture")],
        passthroughSynthesiser(),
        context,
      ),
    ).rejects.toThrow(
      /correctness: correctness exploded.*security: security exploded.*architecture: architecture exploded/s,
    );
  });

  it("throws when every agent fails (single-agent failure fails the review)", async () => {
    const failing = agent("correctness", async () => {
      throw new Error("invalid findings JSON");
    });

    await expect(
      runReviewPipeline([failing], passthroughSynthesiser(), context),
    ).rejects.toThrow(/correctness.*invalid findings JSON/s);
  });

  it("throws when no agents are configured", () => {
    expect(() => buildReviewGraph([], passthroughSynthesiser())).toThrow(
      /at least one review agent/i,
    );
  });
});

describe("runReviewPipeline: synthesis (spec §16)", () => {
  it("skips synthesis with zero candidates and validates the (empty) result", async () => {
    const result = await runReviewPipeline(
      [agent("correctness", async () => [])],
      passthroughSynthesiser(),
      context,
    );

    expect(result.synthesisOutcome).toBe("skipped");
    expect(result.synthesisedCandidateCount).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("feeds raw candidates through the synthesiser and validates its output", async () => {
    const raw = makeFinding({ severity: "low", confidence: 0.5 });
    const refined = makeFinding({ severity: "high", confidence: 0.95 });
    const synthesiser: Synthesiser = {
      async synthesise(candidates) {
        expect(candidates).toEqual([raw]);
        return { findings: [refined], usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };

    const result = await runReviewPipeline(
      [agent("correctness", async () => [raw])],
      synthesiser,
      context,
    );

    expect(result.synthesisOutcome).toBe("completed");
    expect(result.synthesisedCandidateCount).toBe(1);
    expect(result.findings).toEqual([refined]);
  });

  it("falls back to the raw candidates when synthesis fails, and still validates them", async () => {
    const raw = makeFinding();
    const failing: Synthesiser = {
      async synthesise() {
        throw new Error("anthropic unavailable");
      },
    };

    const result = await runReviewPipeline(
      [agent("correctness", async () => [raw])],
      failing,
      context,
    );

    expect(result.synthesisOutcome).toBe("failed");
    expect(result.synthesisError).toBe("anthropic unavailable");
    // Fallback candidates still flow through the exact same deterministic
    // validation chain the synthesised ones would.
    expect(result.findings).toEqual([raw]);
  });
});

describe("runReviewPipeline: deterministic validation (spec §17)", () => {
  it("is never the final authority: a fabricated file/line is dropped by validation", async () => {
    const fabricated = makeFinding({ file: "src/not-part-of-this-pr.ts", line: 7 });
    const synthesiser: Synthesiser = {
      async synthesise() {
        return { findings: [fabricated], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const result = await runReviewPipeline(
      [agent("correctness", async () => [makeFinding()])],
      synthesiser,
      context,
    );

    expect(result.candidates).toEqual([makeFinding()]);
    expect(result.findings).toEqual([]);
  });

  it("validates against the context's changed-file list, the only list there is", async () => {
    // A context whose changed files are DIFFERENT from the module-level
    // `changedFiles` fixture: validation must follow this list, because
    // it is the same one the agents were handed.
    const otherFile: ChangedFile = {
      filename: "src/rate-limit.ts",
      status: "added",
      additions: 2,
      deletions: 0,
      patch: "@@ -0,0 +1,2 @@\n+added line 1\n+added line 2",
    };
    const otherContext: ReviewContext = { ...context, changedFiles: [otherFile] };

    const inThisPr = makeFinding({ file: "src/rate-limit.ts", line: 2 });
    // In the module-level fixture, but NOT in the context the agents saw.
    const notInThisPr = makeFinding({ file: "src/sessions.ts", line: 42 });

    const seenByAgent: (readonly ChangedFile[])[] = [];
    const result = await runReviewPipeline(
      [
        agent("correctness", async (agentContext) => {
          seenByAgent.push(agentContext.changedFiles);
          return [inThisPr, notInThisPr];
        }),
      ],
      passthroughSynthesiser(),
      otherContext,
    );

    // The agents reviewed exactly the list validation filtered against —
    // `runReviewPipeline` takes no second copy that could disagree.
    expect(seenByAgent).toEqual([[otherFile]]);
    expect(result.candidates).toEqual([inThisPr, notInThisPr]);
    expect(result.findings).toEqual([inThisPr]);
  });
});
