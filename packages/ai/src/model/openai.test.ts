/**
 * The OpenAI adapter's mapping in both directions, over an injected SDK
 * stub — no client construction, no network.
 */
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { createOpenAiClient, type OpenAiSdkLike } from "./openai.js";
import type { ModelRequest } from "./types.js";

type CreateParams = Parameters<
  OpenAiSdkLike["chat"]["completions"]["create"]
>[0];

function completion(
  message: Partial<OpenAI.Chat.Completions.ChatCompletionMessage> = {},
  overrides: {
    finishReason?: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];
    usage?: OpenAI.Completions.CompletionUsage | undefined;
    choices?: unknown[];
  } = {},
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 0,
    model: "gpt-test-model",
    choices: overrides.choices ?? [
      {
        index: 0,
        finish_reason: overrides.finishReason ?? "stop",
        logprobs: null,
        message: { role: "assistant", content: "hello", refusal: null, ...message },
      },
    ],
    usage:
      "usage" in overrides
        ? overrides.usage
        : { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function stub(response = completion()) {
  const create = vi.fn(async (_params: CreateParams) => response);
  return { sdk: { chat: { completions: { create } } }, create };
}

const baseRequest: ModelRequest = {
  model: "gpt-test-model",
  maxOutputTokens: 512,
  system: "SYSTEM",
  messages: [{ role: "user", content: "review this" }],
};

describe("the OpenAI adapter's request mapping", () => {
  it("sends the system prompt as the first message and the output budget", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage(baseRequest);

    const params = create.mock.calls[0]?.[0];
    expect(params?.model).toBe("gpt-test-model");
    expect(params?.max_completion_tokens).toBe(512);
    expect(params?.messages).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "review this" },
    ]);
  });

  it("maps tools onto the function-tool shape", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      tools: [
        {
          name: "get_diff",
          description: "the diff",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_diff",
          description: "the diff",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("ignores cachePrefix, which this provider has no request field for", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      cachePrefix: true,
    });

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("cachePrefix");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("cache_control");
  });

  it("turns an assistant turn's tool_use blocks into tool_calls", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      messages: [
        { role: "user", content: "review this" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", id: "call_1", name: "get_diff", input: { a: 1 } },
          ],
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.messages[2]).toEqual({
      role: "assistant",
      content: "let me look",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_diff", arguments: '{"a":1}' },
        },
      ],
    });
  });

  it("sends null content for an assistant turn that is only tool calls", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "get_diff", input: {} },
          ],
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.messages[1]).toMatchObject({
      role: "assistant",
      content: null,
    });
  });

  it("expands one turn of tool results into a tool message each", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "call_1", content: "the diff" },
            { type: "tool_result", toolUseId: "call_2", content: "the file" },
          ],
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.messages.slice(1)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "the diff" },
      { role: "tool", tool_call_id: "call_2", content: "the file" },
    ]);
  });

  it("stands in for an empty tool result, which the API rejects", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "call_1", content: "" }],
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "(empty)",
    });
  });

  it("replays unparseable tool arguments as the model wrote them", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "get_file", input: "{not json" }],
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.messages[1]).toMatchObject({
      tool_calls: [{ function: { name: "get_file", arguments: "{not json" } }],
    });
  });

  it("labels a failed tool result, which the API has no error flag for", async () => {
    const { sdk, create } = stub();

    await createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_1",
              content: "path traversal rejected",
              isError: true,
            },
          ],
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "Error: path traversal rejected",
    });
  });
});

describe("the OpenAI adapter's response mapping", () => {
  it("reports the provider it speaks for", () => {
    expect(createOpenAiClient({ apiKey: "sk-test", sdk: stub().sdk }).provider).toBe(
      "openai",
    );
  });

  it("returns the message text as one text block", async () => {
    const { sdk } = stub(completion({ content: "found one" }));

    const response = await createOpenAiClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.content).toEqual([{ type: "text", text: "found one" }]);
    expect(response.stopReason).toBe("stop");
  });

  it("parses tool_calls back into tool_use blocks", async () => {
    const { sdk } = stub(
      completion(
        {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_file", arguments: '{"path":"src/a.ts"}' },
            },
          ],
        } as Partial<OpenAI.Chat.Completions.ChatCompletionMessage>,
        { finishReason: "tool_calls" },
      ),
    );

    const response = await createOpenAiClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "get_file",
        input: { path: "src/a.ts" },
      },
    ]);
    expect(response.stopReason).toBe("tool_calls");
  });

  it("passes unparseable tool arguments through for input validation to reject", async () => {
    const { sdk } = stub(
      completion({
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_file", arguments: "{not json" },
          },
        ],
      } as Partial<OpenAI.Chat.Completions.ChatCompletionMessage>),
    );

    const response = await createOpenAiClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.content).toEqual([
      { type: "tool_use", id: "call_1", name: "get_file", input: "{not json" },
    ]);
  });

  it("subtracts the cached share, so inputTokens is the uncached remainder", async () => {
    const { sdk } = stub(
      completion(
        {},
        {
          usage: {
            prompt_tokens: 10_000,
            completion_tokens: 7,
            total_tokens: 10_007,
            prompt_tokens_details: { cached_tokens: 9_000 },
          } as OpenAI.Completions.CompletionUsage,
        },
      ),
    );

    const response = await createOpenAiClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 9_000,
    });
  });

  it("reports zeroes rather than NaN when the response carries no usage", async () => {
    const { sdk } = stub(completion({}, { usage: undefined }));

    const response = await createOpenAiClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("throws rather than returning an empty review when there is no choice", async () => {
    const { sdk } = stub(completion({}, { choices: [] }));

    await expect(
      createOpenAiClient({ apiKey: "sk-test", sdk }).createMessage(baseRequest),
    ).rejects.toThrow(/no completion choices/);
  });
});
