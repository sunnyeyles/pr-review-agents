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
