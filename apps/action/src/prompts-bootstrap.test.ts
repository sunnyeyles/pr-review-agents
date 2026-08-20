/**
 * The prompt-resolution contract, checked across the package boundary.
 *
 * @pr-review/ai owns the fetch and @pr-review/reviewer owns the
 * synthesis prompt, so neither package can test the pair on its own —
 * only a consumer of both can, and the action is that consumer. These
 * tests re-enact the bootstrap against the public barrels rather than
 * booting the entrypoint, so they pin the wiring contract without a
 * runner or an event payload.
 */
import {
  loadManagedPrompts,
  type AnthropicLike,
  type LangfusePromptClient,
} from "@pr-review/ai";
import { validRemoteSynthesisPrompt } from "../../../packages/ai/src/agent-test-support.js";
import { createCapturingLogger } from "@pr-review/logging";
import {
  SYNTHESIS_SYSTEM_PROMPT,
  createSynthesiser,
} from "@pr-review/reviewer";
import { describe, expect, it, vi } from "vitest";

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

describe("resolving the synthesis prompt across packages", () => {
  it("accepts the in-code synthesis prompt through the contract guard", async () => {
    // The guard must not reject the very prompt this repo ships. If it
    // did, pasting the shipped text into Langfuse unchanged would be
    // silently ignored — a confusing first experience of the feature.
    const { sources, prompts } = await loadManagedPrompts(
      clientReturning(SYNTHESIS_SYSTEM_PROMPT),
      {
        synthesisFallback: SYNTHESIS_SYSTEM_PROMPT,
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
        synthesisFallback: SYNTHESIS_SYSTEM_PROMPT,
        logger: createCapturingLogger().logger,
      },
    );
    expect(sources.synthesis).toBe("langfuse");

    const { anthropic, calls } = recordingAnthropic();
    const synthesiser = createSynthesiser({
      anthropic,
      model: "claude-test-model",
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
      synthesisFallback: SYNTHESIS_SYSTEM_PROMPT,
      logger: createCapturingLogger().logger,
    });

    expect(sources.synthesis).toBe("fallback");
    expect(prompts.synthesis).toBe(SYNTHESIS_SYSTEM_PROMPT);
  });
});
