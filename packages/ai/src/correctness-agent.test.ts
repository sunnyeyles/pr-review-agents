import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChangedFile,
  GithubInstallationClient,
  PullRequestDetails,
} from "@pr-review/github";
import { describe, expect, it, vi } from "vitest";

import { AgentRunError, createCorrectnessAgent } from "./correctness-agent.js";
import type { ReviewContext } from "./review-types.js";

const headSha = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
const baseSha = "0000000000000000000000000000000000000000";

const pullRequest: PullRequestDetails = {
  number: 42,
  title: "Add admin gating to the sessions endpoint",
  body: "Gates session listing behind an admin check.",
  state: "open",
  author: "octocat",
  baseRef: "main",
  baseSha,
  headRef: "feature/admin-gate",
  headSha,
};

const changedFiles: ChangedFile[] = [
  {
    filename: "src/sessions.ts",
    status: "modified",
    additions: 3,
    deletions: 0,
    patch: "@@ -40,2 +40,5 @@",
  },
];

const context: ReviewContext = {
  owner: "octo-org",
  repo: "example-service",
  pullRequest,
  changedFiles,
  diff: "diff --git a/src/sessions.ts b/src/sessions.ts\n+if ((user.isAdmin = true)) {\n",
};

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

function textBlock(text: string): Anthropic.Messages.TextBlock {
  return { type: "text", text, citations: null };
}

function toolUseBlock(
  id: string,
  name: string,
  input: unknown,
): Anthropic.Messages.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

function message(
  content: Anthropic.Messages.ContentBlock[],
  stopReason: Anthropic.Messages.Message["stop_reason"],
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test-model",
    container: null,
    content,
    stop_reason: stopReason,
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

function makeAnthropic(responses: Anthropic.Messages.Message[]) {
  const queue = [...responses];
  const create = vi.fn(
    async (_params: Anthropic.Messages.MessageCreateParamsNonStreaming) => {
      const next = queue.shift();
      if (!next) {
        throw new Error("fake anthropic client ran out of scripted responses");
      }
      return next;
    },
  );
  return { anthropic: { messages: { create } }, create };
}

function makeGithub() {
  return {
    getPullRequest: vi.fn(async () => pullRequest),
    listChangedFiles: vi.fn(async () => changedFiles),
    getDiff: vi.fn(async () => context.diff),
    getFileContents: vi.fn(async () => "export const sessions = [];\n"),
    searchCode: vi.fn(async () => [{ path: "src/sessions.ts", name: "sessions.ts" }]),
    createCheckRun: vi.fn(async () => ({ id: 987 })),
  } satisfies GithubInstallationClient;
}

function makeAgent(
  responses: Anthropic.Messages.Message[],
  options: { maxTurns?: number } = {},
) {
  const { anthropic, create } = makeAnthropic(responses);
  const github = makeGithub();
  const agent = createCorrectnessAgent({
    anthropic,
    model: "claude-test-model",
    github,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  });
  return { agent, create, github };
}

describe("createCorrectnessAgent", () => {
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
    const agent = createCorrectnessAgent({
      anthropic,
      model: "claude-test-model",
      github: makeGithub(),
    });

    await expect(agent.run(context)).rejects.toThrow("529 overloaded");
  });
});
