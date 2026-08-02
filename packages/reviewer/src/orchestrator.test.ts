import type { ReviewAgent, ReviewContext } from "@pr-review/ai";
import { describe, expect, it, vi } from "vitest";

import { runReview } from "./orchestrator.js";

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
  changedFiles: [],
  diff: "",
};

function agent(name: string, run: ReviewAgent["run"]): ReviewAgent {
  return { name, run };
}

describe("runReview", () => {
  it("runs the agents against the context and returns their candidates", async () => {
    const run = vi.fn(async () => [{ some: "candidate" }]);

    const result = await runReview([agent("correctness", run)], context);

    expect(run).toHaveBeenCalledExactlyOnceWith(context);
    expect(result).toEqual({
      candidates: [{ some: "candidate" }],
      agentFailures: [],
    });
  });

  it("combines candidates from multiple agents in agent order", async () => {
    const result = await runReview(
      [
        agent("correctness", async () => [{ id: 1 }, { id: 2 }]),
        agent("security", async () => [{ id: 3 }]),
      ],
      context,
    );

    expect(result.candidates).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("records a failed agent and still returns the successful agents' candidates", async () => {
    const result = await runReview(
      [
        agent("correctness", async () => {
          throw new Error("model unavailable");
        }),
        agent("security", async () => [{ id: 3 }]),
      ],
      context,
    );

    expect(result.candidates).toEqual([{ id: 3 }]);
    expect(result.agentFailures).toEqual([
      { agent: "correctness", error: "model unavailable" },
    ]);
  });

  it("starts all three agents before any of them resolves (real concurrency)", async () => {
    const starts: string[] = [];
    const resolvers: (() => void)[] = [];
    const gated = (name: string) =>
      agent(name, () => {
        starts.push(name);
        return new Promise((resolve) => {
          resolvers.push(() => resolve([{ from: name }]));
        });
      });

    const pending = runReview(
      [gated("correctness"), gated("security"), gated("architecture")],
      context,
    );

    // Every agent has already started even though none has resolved:
    // the orchestrator must never await one agent before starting the
    // next.
    expect(starts).toEqual(["correctness", "security", "architecture"]);

    for (const resolve of resolvers) {
      resolve();
    }
    const result = await pending;
    expect(result.candidates).toEqual([
      { from: "correctness" },
      { from: "security" },
      { from: "architecture" },
    ]);
    expect(result.agentFailures).toEqual([]);
  });

  it("with one of three agents failing, keeps the other two lenses' candidates", async () => {
    const result = await runReview(
      [
        agent("correctness", async () => [{ category: "correctness" }]),
        agent("security", async () => {
          throw new Error("model unavailable");
        }),
        agent("architecture", async () => [{ category: "architecture" }]),
      ],
      context,
    );

    expect(result.candidates).toEqual([
      { category: "correctness" },
      { category: "architecture" },
    ]);
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
      runReview(
        [failing("correctness"), failing("security"), failing("architecture")],
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

    await expect(runReview([failing], context)).rejects.toThrow(
      /correctness.*invalid findings JSON/s,
    );
  });

  it("throws when no agents are configured", async () => {
    await expect(runReview([], context)).rejects.toThrow(
      /at least one review agent/i,
    );
  });
});
