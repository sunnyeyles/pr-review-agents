/**
 * The synthesis prompt end to end: fetched or fallen back to, through
 * the contract guard, and on into the model call that uses it.
 */
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it } from "vitest";

import {
  finalFindingsJson,
  makeModel,
  message,
  repositoryAgents,
  textBlock,
  validRemoteSynthesisPrompt,
} from "./agent-test-support.js";
import {
  buildSynthesisSystemPrompt,
  createSynthesiser,
} from "./agents/synthesiser.js";
import { loadManagedPrompts, type LangfusePromptClient } from "./prompts.js";

const configuredAgents = repositoryAgents();
const SYNTHESIS_SYSTEM_PROMPT = buildSynthesisSystemPrompt(configuredAgents);

/** Records what reached the model and answers with an empty result. */
function recordingModel() {
  return makeModel([message([textBlock(finalFindingsJson([]))], "end_turn")]);
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

    const { model, calls } = recordingModel();
    const synthesiser = createSynthesiser({
      model,
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

    const system = (calls[0]?.prompt ?? []).find(
      (entry) => (entry as { role?: string }).role === "system",
    );
    expect((system as { content?: string } | undefined)?.content).toBe(remote);
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
