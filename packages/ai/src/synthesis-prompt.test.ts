/**
 * The synthesis prompt end to end: fetched or fallen back to, through
 * the contract guard, and on into the model call that uses it.
 */
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it, vi } from "vitest";

import type { AnthropicLike } from "./anthropic.js";
import {
  repositoryAgents,
  validRemoteSynthesisPrompt,
} from "./agent-test-support.js";
import {
  buildSynthesisSystemPrompt,
  createSynthesiser,
} from "./agents/synthesiser.js";
import { loadManagedPrompts, type LangfusePromptClient } from "./prompts.js";

const configuredAgents = repositoryAgents();
const SYNTHESIS_SYSTEM_PROMPT = buildSynthesisSystemPrompt(configuredAgents);

/** The message shape the Anthropic seam resolves to. */
type CreateResult = Awaited<ReturnType<AnthropicLike["messages"]["create"]>>;

/** Records what reached the model and answers with an empty result. */
function recordingAnthropic(): {
  anthropic: AnthropicLike;
  calls: { system?: string }[];
} {
  const calls: { system?: string }[] = [];
  const create = vi.fn((params: { system?: string }) => {
    calls.push(params);
    return Promise.resolve({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-test-model",
      content: [{ type: "text", text: JSON.stringify({ findings: [] }) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as CreateResult);
  });
  return { anthropic: { messages: { create } } as AnthropicLike, calls };
}

function clientReturning(text: string): LangfusePromptClient {
  return { getTextPrompt: () => Promise.resolve(text) };
}

const failingClient: LangfusePromptClient = {
  getTextPrompt: () => Promise.reject(new Error("langfuse unavailable")),
};

describe("resolving the synthesis prompt", () => {
  it("accepts the in-code synthesis prompt through the contract guard", async () => {
    // If the guard rejected the shipped prompt, pasting it into
    // Langfuse unchanged would be silently ignored.
    const { sources, prompts } = await loadManagedPrompts(
      clientReturning(SYNTHESIS_SYSTEM_PROMPT),
      {
        agents: configuredAgents,
        logger: createCapturingLogger().logger,
      },
    );

    expect(sources.synthesis).toBe("langfuse");
    expect(prompts.synthesis).toBe(SYNTHESIS_SYSTEM_PROMPT);
  });

  it("carries a resolved prompt all the way to the model call", async () => {
    const remote = validRemoteSynthesisPrompt("REMOTE SYNTHESIS PROMPT");
    const { prompts, sources } = await loadManagedPrompts(
      clientReturning(remote),
      {
        agents: configuredAgents,
        logger: createCapturingLogger().logger,
      },
    );
    expect(sources.synthesis).toBe("langfuse");

    const { anthropic, calls } = recordingAnthropic();
    const synthesiser = createSynthesiser({
      anthropic,
      model: "claude-test-model",
      agents: configuredAgents,
      systemPrompt: prompts.synthesis,
    });

    await synthesiser.synthesise([
      {
        file: "src/sessions.ts",
        line: 42,
        category: "correctness",
        severity: "high",
        title: "Assignment instead of comparison in admin check",
        explanation:
          "The if condition assigns instead of comparing, so every user passes the check.",
        confidence: 0.9,
      },
    ]);

    expect(calls[0]?.system).toBe(remote);
  });

  it("hands the in-code prompt to the synthesiser when the fetch fails", async () => {
    const { prompts, sources } = await loadManagedPrompts(failingClient, {
      agents: configuredAgents,
      logger: createCapturingLogger().logger,
    });

    expect(sources.synthesis).toBe("fallback");
    expect(prompts.synthesis).toBe(SYNTHESIS_SYSTEM_PROMPT);
  });
});
