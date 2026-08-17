/**
 * The shared agent-runtime behaviours (loop, tool wiring, output
 * parsing, failure semantics), exercised through the Correctness agent
 * exactly as they were when it was the only agent — these tests
 * predate the runtime extraction and keep it refactor-safe.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it } from "vitest";

import { AgentRunError, createReviewAgent } from "./agent-runtime.js";
import {
  context,
  finalFindingsJson,
  headSha,
  makeAnthropic,
  makeFinding,
  makeGithub,
  message,
  pullRequest,
  textBlock,
  toolUseBlock,
} from "./agent-test-support.js";
import { correctnessLens } from "./agents.js";

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
  responses: Anthropic.Messages.Message[],
  options: { maxTurns?: number } = {},
) {
  const { anthropic, create } = makeAnthropic(responses);
  const github = makeGithub();
  const { logger, entries } = createCapturingLogger();
  const agent = createReviewAgent(correctnessLens, {
    anthropic,
    model: "claude-test-model",
    github,
    logger,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  });
  return { agent, create, github, entries };
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
    const { agent, create } = makeAgent([message([textBlock(finalJson)], "end_turn")]);

    await agent.run(context);

    const params = create.mock.calls[0]?.[0];
    expect(params?.model).toBe("claude-test-model");
    expect(params?.messages).toHaveLength(1);
    expect(params?.messages[0]?.role).toBe("user");
    const opening = String(params?.messages[0]?.content);
    expect(opening).toContain(pullRequest.title);
    expect(opening).toContain(pullRequest.body);
    expect(opening).toContain("src/sessions.ts");
    expect(opening).toContain("user.isAdmin = true");
  });

  it("exposes exactly the six read-only review tools to the model", async () => {
    const { agent, create } = makeAgent([message([textBlock(finalJson)], "end_turn")]);

    await agent.run(context);

    const params = create.mock.calls[0]?.[0];
    const toolNames = (params?.tools ?? []).map((tool) => tool.name).sort();
    expect(toolNames).toEqual([
      "get_base_file",
      "get_diff",
      "get_file",
      "get_pull_request",
      "list_changed_files",
      "search_repository",
    ]);
  });

  it("hardens the system prompt against prompt injection", async () => {
    const { agent, create } = makeAgent([message([textBlock(finalJson)], "end_turn")]);

    await agent.run(context);

    const system = String(create.mock.calls[0]?.[0]?.system);
    // Spec §21: repository contents are data, comments are not
    // instructions, tool results grant no permissions, findings only
    // via the final JSON — and §9/§14: correctness focus, no style.
    expect(system).toMatch(/data.*not instructions|never instructions/is);
    expect(system).toMatch(/comments?.*(never|not).*instructions/is);
    expect(system).toMatch(/tool (results?|output).*(no|cannot|never).*(permission|privilege)/is);
    expect(system).toMatch(/final JSON/i);
    expect(system).toMatch(/correctness/i);
    expect(system).toMatch(/(not|never).*(formatting|style)/is);
  });

  it("round-trips a tool_use through the github client and replays the result", async () => {
    const { agent, create, github } = makeAgent([
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

    const secondParams = create.mock.calls[1]?.[0];
    expect(secondParams?.messages).toHaveLength(3);
    expect(secondParams?.messages[1]?.role).toBe("assistant");
    expect(secondParams?.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "export const sessions = [];\n",
        },
      ],
    });
  });

  it("answers malformed tool input with an error tool_result and keeps going", async () => {
    const { agent, create, github } = makeAgent([
      message(
        [toolUseBlock("toolu_1", "get_file", { path: "../../etc/passwd" })],
        "tool_use",
      ),
      message([textBlock(finalJson)], "end_turn"),
    ]);

    const findings = await agent.run(context);

    expect(findings).toEqual([finding]);
    expect(github.getFileContents).not.toHaveBeenCalled();
    const secondParams = create.mock.calls[1]?.[0];
    expect(secondParams?.messages[2]).toEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
        }),
      ],
    });
  });

  it("answers an unknown tool with an error tool_result", async () => {
    const { agent, create } = makeAgent([
      message([toolUseBlock("toolu_1", "merge_pull_request", {})], "tool_use"),
      message([textBlock(finalJson)], "end_turn"),
    ]);

    await agent.run(context);

    const secondParams = create.mock.calls[1]?.[0];
    expect(secondParams?.messages[2]).toEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
        }),
      ],
    });
  });

  it("answers parallel tool_use blocks with one tool_result each", async () => {
    const { agent, create } = makeAgent([
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

    const secondParams = create.mock.calls[1]?.[0];
    const results = secondParams?.messages[2]?.content;
    expect(Array.isArray(results)).toBe(true);
    if (Array.isArray(results)) {
      expect(results.map((block) => (block as { tool_use_id: string }).tool_use_id)).toEqual(
        ["toolu_1", "toolu_2"],
      );
    }
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
    const { anthropic } = makeAnthropic([]);
    anthropic.messages.create.mockRejectedValueOnce(new Error("529 overloaded"));
    const agent = createReviewAgent(correctnessLens, {
      anthropic,
      model: "claude-test-model",
      github: makeGithub(),
      logger: createCapturingLogger().logger,
    });

    await expect(agent.run(context)).rejects.toThrow("529 overloaded");
  });
});

describe("category integrity", () => {
  // Decision (ticket 07): the runtime FILTERS the final findings to the
  // agent's own category rather than re-stamping leaked ones. Stamping
  // would fabricate a claim the model never made (a security-worded
  // finding relabelled "correctness" misleads rendering and synthesis);
  // filtering keeps category provenance deterministic — downstream code
  // can trust that every candidate an agent contributes carries that
  // agent's lens — and an out-of-role finding sits outside the agent's
  // assigned review role (§21) anyway, so it is dropped, not laundered.
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
  // Every event of one agent run carries the review's identity plus
  // the agent name, so an operator can correlate it with the rest of
  // the review's events in CloudWatch.
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
    // A two-turn run: usage must be SUMMED across both model calls.
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
    const { anthropic } = makeAnthropic([]);
    anthropic.messages.create.mockRejectedValueOnce(new Error("529 overloaded"));
    const { logger, entries } = createCapturingLogger();
    const agent = createReviewAgent(correctnessLens, {
      anthropic,
      model: "claude-test-model",
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
    const { anthropic } = makeAnthropic([]);
    anthropic.messages.create
      .mockImplementationOnce(async () => toolTurn)
      .mockRejectedValueOnce(new Error("529 overloaded"));
    const { logger, entries } = createCapturingLogger();
    const agent = createReviewAgent(correctnessLens, {
      anthropic,
      model: "claude-test-model",
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
