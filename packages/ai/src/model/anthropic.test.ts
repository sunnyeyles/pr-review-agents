/**
 * The Anthropic adapter's mapping in both directions, over an injected
 * SDK stub — no client construction, no network.
 */
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAnthropicClient, type AnthropicSdkLike } from "./anthropic.js";
import type { ModelRequest } from "./types.js";

type CreateParams = Parameters<AnthropicSdkLike["messages"]["create"]>[0];

function anthropicMessage(
  overrides: Partial<Anthropic.Messages.Message> = {},
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test-model",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
    ...overrides,
  } as Anthropic.Messages.Message;
}

function stub(response = anthropicMessage()) {
  const create = vi.fn(async (_params: CreateParams) => response);
  return { sdk: { messages: { create } }, create };
}

const baseRequest: ModelRequest = {
  model: "claude-test-model",
  maxOutputTokens: 512,
  system: "SYSTEM",
  messages: [{ role: "user", content: "review this" }],
};

describe("the Anthropic adapter's request mapping", () => {
  it("sends the model, output budget, system prompt, and messages", async () => {
    const { sdk, create } = stub();

    await createAnthropicClient({ apiKey: "sk-test", sdk }).createMessage(
      baseRequest,
    );

    const params = create.mock.calls[0]?.[0];
    expect(params?.model).toBe("claude-test-model");
    expect(params?.max_tokens).toBe(512);
    expect(params?.system).toEqual([{ type: "text", text: "SYSTEM" }]);
    expect(params?.messages).toEqual([{ role: "user", content: "review this" }]);
  });

  it("marks the system prompt and the conversation tail as cache breakpoints only when asked", async () => {
    const { sdk, create } = stub();
    const client = createAnthropicClient({ apiKey: "sk-test", sdk });

    await client.createMessage({ ...baseRequest, cachePrefix: true });
    await client.createMessage(baseRequest);

    const cached = create.mock.calls[0]?.[0];
    expect(cached?.system).toEqual([
      { type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } },
    ]);
    expect(create.mock.calls[1]?.[0]?.system).toEqual([
      { type: "text", text: "SYSTEM" },
    ]);
    expect(cached?.cache_control).toEqual({ type: "ephemeral" });
    expect(create.mock.calls[1]?.[0]?.cache_control).toBeUndefined();
  });

  it("renames the tool schema field the SDK spells differently", async () => {
    const { sdk, create } = stub();

    await createAnthropicClient({ apiKey: "sk-test", sdk }).createMessage({
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
        name: "get_diff",
        description: "the diff",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("omits tools entirely when the request carries none", async () => {
    const { sdk, create } = stub();

    await createAnthropicClient({ apiKey: "sk-test", sdk }).createMessage(
      baseRequest,
    );

    expect(create.mock.calls[0]?.[0]?.tools).toBeUndefined();
  });

  it("maps assistant tool_use and user tool_result blocks onto SDK spellings", async () => {
    const { sdk, create } = stub();

    await createAnthropicClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      messages: [
        { role: "user", content: "review this" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", id: "toolu_1", name: "get_diff", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "toolu_1", content: "the diff" },
            {
              type: "tool_result",
              toolUseId: "toolu_2",
              content: "boom",
              isError: true,
            },
          ],
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", id: "toolu_1", name: "get_diff", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "the diff" },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "boom",
            is_error: true,
          },
        ],
      },
    ]);
  });
});

describe("the Anthropic adapter's response mapping", () => {
  it("reports the provider it speaks for", () => {
    expect(createAnthropicClient({ apiKey: "sk-test", sdk: stub().sdk }).provider).toBe(
      "anthropic",
    );
  });

  it("returns text and tool_use blocks, keeping thinking as opaque provider state", async () => {
    const thinking = { type: "thinking", thinking: "hmm", signature: "sig" };
    const { sdk } = stub(
      anthropicMessage({
        content: [
          { type: "text", text: "found one" },
          thinking,
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
          { type: "tool_use", id: "toolu_1", name: "get_diff", input: { a: 1 } },
        ] as unknown as Anthropic.Messages.ContentBlock[],
      }),
    );

    const response = await createAnthropicClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.content).toEqual([
      { type: "text", text: "found one" },
      { type: "provider", provider: "anthropic", block: thinking },
      { type: "tool_use", id: "toolu_1", name: "get_diff", input: { a: 1 } },
    ]);
  });

  it("replays its own provider blocks verbatim and drops another provider's", async () => {
    const thinking = { type: "thinking", thinking: "hmm", signature: "sig" };
    const { sdk, create } = stub();

    await createAnthropicClient({ apiKey: "sk-test", sdk }).createMessage({
      ...baseRequest,
      messages: [
        { role: "user", content: "review this" },
        {
          role: "assistant",
          content: [
            { type: "provider", provider: "anthropic", block: thinking },
            { type: "provider", provider: "openai", block: { type: "reasoning" } },
            { type: "tool_use", id: "toolu_1", name: "get_diff", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "toolu_1", content: "the diff" }],
        },
      ],
    });

    expect(create.mock.calls[0]?.[0]?.messages[1]).toEqual({
      role: "assistant",
      content: [
        thinking,
        { type: "tool_use", id: "toolu_1", name: "get_diff", input: {} },
      ],
    });
  });

  it("passes the stop reason through, and reports none as undefined", async () => {
    const { sdk } = stub(anthropicMessage({ stop_reason: null }));

    const response = await createAnthropicClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.stopReason).toBeUndefined();
  });

  it("normalises absent cache counters to zero rather than null", async () => {
    const { sdk } = stub(
      anthropicMessage({
        usage: {
          input_tokens: 11,
          output_tokens: 7,
        } as Anthropic.Messages.Usage,
      }),
    );

    const response = await createAnthropicClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("keeps the cache counters apart from the uncached input remainder", async () => {
    const { sdk } = stub(
      anthropicMessage({
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 9_000,
        } as Anthropic.Messages.Usage,
      }),
    );

    const response = await createAnthropicClient({
      apiKey: "sk-test",
      sdk,
    }).createMessage(baseRequest);

    expect(response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 9_000,
    });
  });
});

describe("building the real Anthropic SDK client", () => {
  const AMBIENT_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
  const saved = new Map<string, string | undefined>();
  let fetchSpy: ReturnType<typeof vi.fn>;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const key of AMBIENT_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    realFetch = globalThis.fetch;
    fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(anthropicMessage()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
  });

  /** The URL and headers of the one request the SDK made. */
  function sentRequest(): { url: string; apiKey: string | null } {
    const [input, init] = fetchSpy.mock.calls[0] as [
      unknown,
      RequestInit | undefined,
    ];
    const headers = new Headers(init?.headers);
    return { url: String(input), apiKey: headers.get("x-api-key") };
  }

  it("makes no request while constructing the client", () => {
    createAnthropicClient({ apiKey: "sk-test-key" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("authenticates with the injected key, not the ambient environment", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ambient-key";

    await createAnthropicClient({ apiKey: "sk-injected-key" }).createMessage(
      baseRequest,
    );

    expect(sentRequest().apiKey).toBe("sk-injected-key");
  });

  it("sends to the configured base URL when one is given", async () => {
    await createAnthropicClient({
      apiKey: "sk-test-key",
      baseUrl: "https://gateway.example",
    }).createMessage(baseRequest);

    expect(sentRequest().url).toBe("https://gateway.example/v1/messages");
  });

  it("uses the SDK's own host when no base URL is given", async () => {
    await createAnthropicClient({ apiKey: "sk-test-key" }).createMessage(
      baseRequest,
    );

    expect(sentRequest().url).toBe("https://api.anthropic.com/v1/messages");
  });
});
