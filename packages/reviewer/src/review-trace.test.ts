/**
 * One review is one trace. The agents and the synthesiser start their
 * own observations without naming a parent, so this pins that they land
 * under the pipeline's root span rather than each opening a trace of
 * their own — the id the comments carry has to be the one their spans
 * are under.
 */
import { emptyTokenUsage, type ReviewContext, type Synthesiser } from "@pr-review/ai";
import type { ReviewFinding } from "@pr-review/schemas";
import { startObservation } from "@langfuse/tracing";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runReviewPipeline } from "./review-graph.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  provider.register();
});
beforeEach(() => {
  exporter.reset();
});
afterAll(async () => {
  await provider.shutdown();
});

const context: ReviewContext = {
  owner: "octo-org",
  repo: "example-service",
  pullRequest: {
    number: 42,
    title: "Add rate limiting",
    body: null,
    author: "octocat",
    baseRef: "main",
    baseSha: "0000000000000000000000000000000000000000",
    headRef: "feature/rate-limit",
    headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  },
  changedFiles: [
    {
      filename: "src/sessions.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -41,1 +41,2 @@\n context line 41\n+added line 42",
    },
  ],
  diff: "",
};

const finding: ReviewFinding = {
  file: "src/sessions.ts",
  line: 42,
  category: "correctness",
  severity: "high",
  title: "Assignment instead of comparison in admin check",
  explanation: "The condition assigns instead of comparing.",
  confidence: 0.9,
};

/** Mirrors how the real runtime and synthesiser open their observations. */
function observed<T>(name: string, work: () => Promise<T>): Promise<T> {
  const observation = startObservation(name, {}, { asType: "chain" });
  return work().finally(() => observation.end());
}

const synthesiser: Synthesiser = {
  synthesise: (candidates) =>
    observed("synthesise-findings", async () => ({
      findings: candidates as ReviewFinding[],
      usage: emptyTokenUsage(),
    })),
};

describe("runReviewPipeline tracing", () => {
  it("nests every agent and synthesis span under one trace and reports its id", async () => {
    const result = await runReviewPipeline(
      [
        { name: "correctness", run: () => observed("review-agent", async () => [finding]) },
        { name: "security", run: () => observed("review-agent", async () => []) },
      ],
      synthesiser,
      context,
    );

    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name).sort()).toEqual([
      "review-agent",
      "review-agent",
      "review-pull-request",
      "synthesise-findings",
    ]);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(result.traceId);
    }
  });

  it("records what was reviewed on the root span, never the diff", async () => {
    await runReviewPipeline(
      [{ name: "correctness", run: async () => [finding] }],
      synthesiser,
      context,
    );

    const root = exporter
      .getFinishedSpans()
      .find((span) => span.name === "review-pull-request");
    const input = JSON.parse(String(root?.attributes["langfuse.observation.input"]));
    expect(input).toEqual({
      repository: "octo-org/example-service",
      pullRequestNumber: 42,
      headSha: context.pullRequest.headSha,
      agents: ["correctness"],
    });
  });
});
