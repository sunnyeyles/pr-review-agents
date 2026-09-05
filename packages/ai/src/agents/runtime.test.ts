/**
 * The shared agent-runtime behaviours — loop, tool wiring, output
 * parsing, failure semantics — exercised through the Correctness agent.
 */
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it } from "vitest";

import { buildReviewSystemPrompt } from "./definition.js";
import {
  AgentRunError,
  createReviewAgent,
  type ReviewSystemPrompts,
} from "./runtime.js";
import {
  context,
  finalFindingsJson,
  headSha,
  makeFinding,
  makeGithub,
  makeModel,
  message,
  pullRequest,
  repositoryAgent,
  textBlock,
  toolUseBlock,
} from "../agent-test-support.js";

type ScriptedResponse = ReturnType<typeof message>;

/** One provider-level call as the SDK assembled it. */
type Call = { prompt: unknown[]; tools?: unknown[] };

const correctnessAgent = repositoryAgent("correctness");

/** The system instructions of one recorded call. */
function systemOf(call: Call | undefined): string {
  const system = (call?.prompt ?? []).find(
    (entry) => (entry as { role?: string }).role === "system",
  );
  return String((system as { content?: string } | undefined)?.content ?? "");
}

/** The opening user text of one recorded call. */
function openingOf(call: Call | undefined): string {
  const user = (call?.prompt ?? []).find(
    (entry) => (entry as { role?: string }).role === "user",
  );
  const parts = (user as { content?: { type: string; text?: string }[] })
    ?.content;
  return (parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function toolNamesOf(call: Call | undefined): string[] {
  return (call?.tools ?? [])
    .map((tool) => String((tool as { name?: string }).name))
    .sort();
}

/** Every Anthropic cache breakpoint in one recorded call's prompt. */
function cacheMarkersOf(call: Call | undefined): unknown[] {
  return (call?.prompt ?? [])
    .map(
      (entry) =>
        (
          entry as {
            providerOptions?: { anthropic?: { cacheControl?: unknown } };
          }
        ).providerOptions?.anthropic?.cacheControl,
    )
    .filter((marker) => marker !== undefined);
}

interface ToolResultPart {
  toolCallId: string;
  toolName: string;
  output: { type: string; value: unknown };
}

/** The tool results the SDK fed back into one recorded call. */
function toolResultsOf(call: Call | undefined): ToolResultPart[] {
  return (call?.prompt ?? [])
    .filter((entry) => (entry as { role?: string }).role === "tool")
    .flatMap(
      (entry) => (entry as { content: ToolResultPart[] }).content ?? [],
    );
}

const finding = {
  file: "src/sessions.ts",
  line: 42,
  category: "correctness" as const,
  severity: "high" as const,
  title: "Assignment instead of comparison in admin check",
  explanation: "The if condition assigns instead of comparing, so every user passes.",
  confidence: 0.95,
};

const finalJson = JSON.stringify({ findings: [finding] });

function makeAgent(
  responses: ScriptedResponse[],
  options: { maxTurns?: number; systemPrompts?: ReviewSystemPrompts } = {},
) {
  const { model, doGenerate: create, calls } = makeModel(responses);
  const github = makeGithub();
  const { logger, entries } = createCapturingLogger();
  const agent = createReviewAgent(correctnessAgent, {
    model,
    github,
    logger,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.systemPrompts !== undefined
      ? { systemPrompts: options.systemPrompts }
      : {}),
  });
  return { agent, create, calls: calls as unknown as Call[], github, entries };
}

describe("the Correctness agent", () => {
  it("is named correctness", () => {
    const { agent } = makeAgent([]);

    expect(agent.name).toBe("correctness");
  });

  it("returns findings parsed from the model's final JSON message", async () => {
    const { agent, create } = makeAgent([message([textBlock(finalJson)], "end_turn")]);

    const findings = await agent.run(context);

    expect(findings).toEqual([finding]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("opens with the PR title, description, changed files, and diff", async () => {
    const { agent, calls } = makeAgent([
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    const opening = openingOf(calls[0]);
    expect(opening).toContain(pullRequest.title);
    expect(opening).toContain(pullRequest.body);
    expect(opening).toContain("src/sessions.ts");
    expect(opening).toContain("user.isAdmin = true");
  });

  it("exposes exactly the six read-only review tools to the model", async () => {
    const { agent, calls } = makeAgent([
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    expect(toolNamesOf(calls[0])).toEqual([
      "get_base_file",
      "get_diff",
      "get_file",
      "get_pull_request",
      "list_changed_files",
      "search_repository",
    ]);
  });

  it("hardens the system prompt against prompt injection", async () => {
    const { agent, calls } = makeAgent([
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    const system = systemOf(calls[0]);
    // The hardening rules plus the correctness agent's own focus.
    expect(system).toMatch(/data.*not instructions|never instructions/is);
    expect(system).toMatch(/comments?.*(never|not).*instructions/is);
    expect(system).toMatch(/tool (results?|output).*(no|cannot|never).*(permission|privilege)/is);
    expect(system).toMatch(/final JSON/i);
    expect(system).toMatch(/correctness/i);
    expect(system).toMatch(/(not|never).*(formatting|style)/is);
  });

  it("round-trips a tool call through the github client and replays the result", async () => {
    const { agent, calls, github } = makeAgent([
      message(
        [toolUseBlock("toolu_1", "get_file", { path: "src/sessions.ts" })],
        "tool_use",
      ),
      message([textBlock(finalJson)], "end_turn"),
    ]);

    const findings = await agent.run(context);

    expect(findings).toEqual([finding]);
    expect(github.getFileContents).toHaveBeenCalledExactlyOnceWith({
      owner: "octo-org",
      repo: "example-service",
      path: "src/sessions.ts",
      ref: headSha,
    });

    expect(toolResultsOf(calls[1])).toEqual([
      {
        type: "tool-result",
        toolCallId: "toolu_1",
        toolName: "get_file",
        output: { type: "text", value: "export const sessions = [];\n" },
      },
    ]);
  });

  it("answers malformed tool input with an error result and keeps going", async () => {
    const { agent, calls, github } = makeAgent([
      message(
        [toolUseBlock("toolu_1", "get_file", { path: "../../etc/passwd" })],
        "tool_use",
      ),
      message([textBlock(finalJson)], "end_turn"),
    ]);

    const findings = await agent.run(context);

    expect(findings).toEqual([finding]);
    expect(github.getFileContents).not.toHaveBeenCalled();
    expect(toolResultsOf(calls[1])).toEqual([
      expect.objectContaining({
        toolCallId: "toolu_1",
        output: expect.objectContaining({ type: "error-text" }),
      }),
    ]);
  });

  it("answers an unknown tool with an error result", async () => {
    const { agent, calls } = makeAgent([
      message([toolUseBlock("toolu_1", "merge_pull_request", {})], "tool_use"),
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    expect(toolResultsOf(calls[1])).toEqual([
      expect.objectContaining({
        toolCallId: "toolu_1",
        output: expect.objectContaining({ type: "error-text" }),
      }),
    ]);
  });

  it("surfaces a failing github call to the model rather than throwing", async () => {
    const { agent, github, calls } = makeAgent([
      message(
        [toolUseBlock("toolu_1", "get_file", { path: "src/missing.ts" })],
        "tool_use",
      ),
      message([textBlock(finalJson)], "end_turn"),
    ]);
    github.getFileContents.mockRejectedValueOnce(new Error("404 not found"));

    await expect(agent.run(context)).resolves.toEqual([finding]);
    expect(toolResultsOf(calls[1])).toEqual([
      expect.objectContaining({
        toolCallId: "toolu_1",
        output: { type: "error-text", value: expect.stringContaining("404") },
      }),
    ]);
  });

  it("answers parallel tool calls with one result each", async () => {
    const { agent, calls } = makeAgent([
      message(
        [
          toolUseBlock("toolu_1", "get_file", { path: "src/sessions.ts" }),
          toolUseBlock("toolu_2", "search_repository", { query: "isAdmin" }),
        ],
        "tool_use",
      ),
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    expect(toolResultsOf(calls[1]).map((part) => part.toolCallId)).toEqual([
      "toolu_1",
      "toolu_2",
    ]);
  });

  it("extracts findings from a fenced JSON final message", async () => {
    const fenced = ["My review is complete.", "```json", finalJson, "```"].join("\n");
    const { agent } = makeAgent([message([textBlock(fenced)], "end_turn")]);

    await expect(agent.run(context)).resolves.toEqual([finding]);
  });

  it("rejects with AgentRunError when the final message is not valid findings JSON", async () => {
    const { agent } = makeAgent([
      message([textBlock("I found several bugs, here they are in prose.")], "end_turn"),
    ]);

    await expect(agent.run(context)).rejects.toThrow(AgentRunError);
  });

  it("rejects with AgentRunError when the max-turns cap is exceeded", async () => {
    const toolTurn = () =>
      message(
        [toolUseBlock("toolu_1", "get_diff", {})],
        "tool_use",
      );
    const { agent, create } = makeAgent([toolTurn(), toolTurn(), toolTurn()], {
      maxTurns: 2,
    });

    await expect(agent.run(context)).rejects.toThrow(/turn/i);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("propagates model API failures", async () => {
    const { model, doGenerate } = makeModel([]);
    doGenerate.mockRejectedValueOnce(new Error("529 overloaded"));
    const agent = createReviewAgent(correctnessAgent, {
      model,
      github: makeGithub(),
      logger: createCapturingLogger().logger,
    });

    await expect(agent.run(context)).rejects.toThrow("529 overloaded");
  });
});

describe("category integrity", () => {
  // The runtime filters rather than re-stamps: relabelling would
  // fabricate a claim the model never made.
  it("drops findings outside the agent's own category and keeps its own", async () => {
    const own = makeFinding("correctness");
    const leakedSecurity = makeFinding("security", { line: 43 });
    const leakedArchitecture = makeFinding("architecture", { line: 44 });
    const { agent } = makeAgent([
      message(
        [textBlock(finalFindingsJson([leakedSecurity, own, leakedArchitecture]))],
        "end_turn",
      ),
    ]);

    await expect(agent.run(context)).resolves.toEqual([own]);
  });

  it("returns an empty set when every finding leaked out of category", async () => {
    const { agent } = makeAgent([
      message(
        [textBlock(finalFindingsJson([makeFinding("security")]))],
        "end_turn",
      ),
    ]);

    await expect(agent.run(context)).resolves.toEqual([]);
  });
});

describe("lifecycle events (spec §26)", () => {
  // Every event carries the review's identity plus the agent name.
  const correlation = {
    repository: "octo-org/example-service",
    pullRequestNumber: 42,
    headSha,
    agent: "correctness",
  };

  it("emits agent.started with the correlation fields before any model call", async () => {
    const { agent, entries } = makeAgent([
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    expect(entries[0]).toMatchObject({
      level: "info",
      event: "agent.started",
      ...correlation,
    });
  });

  it("emits agent.completed with duration, aggregated token usage, and finding count", async () => {
    // A two-turn run: usage must be summed across both model calls.
    const { agent, entries } = makeAgent([
      message([toolUseBlock("toolu_1", "get_diff", {})], "tool_use", {
        inputTokens: 100,
        outputTokens: 10,
      }),
      message([textBlock(finalJson)], "end_turn", {
        inputTokens: 250,
        outputTokens: 25,
      }),
    ]);

    await agent.run(context);

    expect(entries.map((entry) => entry.event)).toEqual([
      "agent.started",
      "agent.completed",
    ]);
    const completed = entries[1];
    expect(completed).toMatchObject({
      level: "info",
      event: "agent.completed",
      ...correlation,
      inputTokens: 350,
      outputTokens: 35,
      findingCount: 1,
    });
    expect(typeof completed?.["durationMs"]).toBe("number");
  });

  it("emits agent.failed with the error and usage so far when the final output is invalid", async () => {
    const { agent, entries } = makeAgent([
      message([textBlock("prose, not JSON")], "end_turn", {
        inputTokens: 80,
        outputTokens: 8,
      }),
    ]);

    await expect(agent.run(context)).rejects.toThrow(AgentRunError);

    expect(entries.map((entry) => entry.event)).toEqual([
      "agent.started",
      "agent.failed",
    ]);
    const failed = entries[1];
    expect(failed).toMatchObject({
      level: "error",
      event: "agent.failed",
      ...correlation,
      errorName: "AgentRunError",
      inputTokens: 80,
      outputTokens: 8,
    });
    expect(failed?.["error"]).toMatch(/invalid findings output/i);
    expect(typeof failed?.["durationMs"]).toBe("number");
  });

  it("emits agent.failed when the model API call rejects", async () => {
    const { model, doGenerate } = makeModel([]);
    doGenerate.mockRejectedValueOnce(new Error("529 overloaded"));
    const { logger, entries } = createCapturingLogger();
    const agent = createReviewAgent(correctnessAgent, {
      model,
      github: makeGithub(),
      logger,
    });

    await expect(agent.run(context)).rejects.toThrow("529 overloaded");

    expect(entries[1]).toMatchObject({
      level: "error",
      event: "agent.failed",
      ...correlation,
      error: "529 overloaded",
      errorName: "Error",
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("reports the tokens already spent when a later model call rejects", async () => {
    const toolTurn = message(
      [toolUseBlock("toolu_1", "get_diff", {})],
      "tool_use",
      { inputTokens: 40, outputTokens: 4 },
    );
    const { model, doGenerate } = makeModel([]);
    doGenerate
      .mockImplementationOnce(async () => toolTurn)
      .mockRejectedValueOnce(new Error("529 overloaded"));
    const { logger, entries } = createCapturingLogger();
    const agent = createReviewAgent(correctnessAgent, {
      model,
      github: makeGithub(),
      logger,
    });

    await expect(agent.run(context)).rejects.toThrow("529 overloaded");

    expect(entries[1]).toMatchObject({
      event: "agent.failed",
      inputTokens: 40,
      outputTokens: 4,
    });
  });

  it("emits agent.failed when the turn cap is exceeded, with the usage burned so far", async () => {
    const toolTurn = () =>
      message([toolUseBlock("toolu_1", "get_diff", {})], "tool_use", {
        inputTokens: 40,
        outputTokens: 4,
      });
    const { agent, entries } = makeAgent([toolTurn(), toolTurn(), toolTurn()], {
      maxTurns: 2,
    });

    await expect(agent.run(context)).rejects.toThrow(/turn/i);

    const failed = entries[1];
    expect(failed).toMatchObject({
      level: "error",
      event: "agent.failed",
      ...correlation,
      errorName: "AgentRunError",
      inputTokens: 80,
      outputTokens: 8,
    });
    expect(failed?.["error"]).toMatch(/turn/i);
  });
});

describe("prompt caching", () => {
  it("asks the provider to cache the stable prefix on every turn", async () => {
    const { agent, create, calls } = makeAgent([
      message([toolUseBlock("toolu_1", "get_diff", {})], "tool_use"),
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    expect(create).toHaveBeenCalledTimes(2);
    for (const call of calls) {
      expect(systemOf(call)).toBe(buildReviewSystemPrompt(correctnessAgent));
      expect(cacheMarkersOf(call)).toEqual([{ type: "ephemeral" }]);
    }
  });

  it("sends a byte-identical prefix between turns, so the cache can hit", async () => {
    // Caching depends on turn two repeating turn one's prefix unchanged.
    const { agent, calls } = makeAgent([
      message([toolUseBlock("toolu_1", "get_diff", {})], "tool_use"),
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    const [first, second] = calls;
    expect(systemOf(second)).toEqual(systemOf(first));
    expect(second?.tools).toEqual(first?.tools);
    expect(cacheMarkersOf(second)).toEqual(cacheMarkersOf(first));
    expect(second?.prompt.slice(0, first?.prompt.length)).toEqual(first?.prompt);
    expect(second?.prompt.length).toBeGreaterThan(first?.prompt.length ?? 0);
  });

  it("reports cache writes and reads separately on agent.completed", async () => {
    // A working cache: turn one writes the prefix, turn two reads it.
    const { agent, entries } = makeAgent([
      message([toolUseBlock("toolu_1", "get_diff", {})], "tool_use", {
        inputTokens: 12,
        outputTokens: 10,
        cacheCreationInputTokens: 4_000,
      }),
      message([textBlock(finalJson)], "end_turn", {
        inputTokens: 8,
        outputTokens: 25,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 4_000,
      }),
    ]);

    await agent.run(context);

    expect(entries[1]).toMatchObject({
      event: "agent.completed",
      inputTokens: 20,
      cacheCreationInputTokens: 4_300,
      cacheReadInputTokens: 4_000,
      outputTokens: 35,
    });
  });
});

describe("pre-resolved system prompts", () => {
  it("uses the injected prompt for an agent that has one", async () => {
    const injected = "INJECTED CORRECTNESS SYSTEM PROMPT";
    const { agent, calls } = makeAgent(
      [message([textBlock(finalJson)], "end_turn")],
      { systemPrompts: { correctness: injected } },
    );

    await agent.run(context);

    expect(systemOf(calls[0])).toBe(injected);
  });

  it("falls back to the in-code prompt for an agent that has none", async () => {
    // A map covering only other agents must leave this one untouched.
    const { agent, calls } = makeAgent(
      [message([textBlock(finalJson)], "end_turn")],
      { systemPrompts: { security: "SOMEONE ELSE'S PROMPT" } },
    );

    await agent.run(context);

    expect(systemOf(calls[0])).toBe(buildReviewSystemPrompt(correctnessAgent));
  });
});
