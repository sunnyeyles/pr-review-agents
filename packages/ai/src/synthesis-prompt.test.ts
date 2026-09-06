/**
 * The synthesis prompt is built from the run's agent set and never managed.
 * A stored copy would name categories the run no longer has.
 */
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it, vi } from "vitest";

import {
  finalFindingsJson,
  makeModel,
  message,
  repositoryAgents,
  textBlock,
  validRemotePrompt,
} from "./agent-test-support.js";
import {
  buildSynthesisSystemPrompt,
  createSynthesiser,
} from "./agents/synthesiser.js";
import { inCodePrompts, loadManagedPrompts, type LangfusePromptClient } from "./prompts.js";

const configuredAgents = repositoryAgents();
const SYNTHESIS_SYSTEM_PROMPT = buildSynthesisSystemPrompt(configuredAgents);

/** Records what reached the model and answers with an empty result. */
function recordingModel() {
  return makeModel([message([textBlock(finalFindingsJson([]))], "end_turn")]);
}

const candidate = {
  file: "src/sessions.ts",
  line: 42,
  category: "security",
  severity: "high" as const,
  title: "Session listing is not gated behind an admin check",
  explanation: "Any authenticated user can list every session.",
  confidence: 0.9,
};

describe("the synthesis prompt is not managed", () => {
  it("is never fetched from Langfuse", async () => {
    const client: LangfusePromptClient = {
      getTextPrompt: vi.fn(() =>
        Promise.resolve(validRemotePrompt("security", "REMOTE")),
      ),
    };

    await loadManagedPrompts(client, {
      agents: configuredAgents,
      logger: createCapturingLogger().logger,
    });

    const fetched = (client.getTextPrompt as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0],
    );
    expect(fetched).not.toContain("synthesis_system");
  });

  it("is not one of the prompts the seeder publishes", () => {
    expect(Object.keys(inCodePrompts(configuredAgents))).not.toContain("synthesis");
  });

  it("reaches the model call built from the run's agent set", async () => {
    const { model, calls } = recordingModel();

    await createSynthesiser({ model, agents: configuredAgents }).synthesise([
      candidate,
    ]);

    const system = (calls[0]?.prompt ?? []).find(
      (entry) => (entry as { role?: string }).role === "system",
    );
    expect((system as { content?: string } | undefined)?.content).toBe(
      SYNTHESIS_SYSTEM_PROMPT,
    );
  });
});
