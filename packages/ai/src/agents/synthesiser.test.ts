import type { ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import { MockLanguageModelV4 } from "ai/test";

import { finalFindingsJson, repositoryAgents } from "../agent-test-support.js";
import type { ReviewModel } from "../model.js";
import {
  SynthesisError,
  buildSynthesisMessage,
  buildSynthesisSystemPrompt,
  createSynthesiser,
} from "./synthesiser.js";

const configuredAgents = repositoryAgents();
const SYNTHESIS_SYSTEM_PROMPT = buildSynthesisSystemPrompt(configuredAgents);

/** A schema-valid candidate finding, overridable per test. */
function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: "src/sessions.ts",
    line: 42,
    category: "correctness",
    severity: "high",
    title: "Assignment instead of comparison in admin check",
    explanation:
      "The if condition assigns true to user.isAdmin instead of comparing, so every user passes the check.",
    confidence: 0.9,
    ...overrides,
  };
}

/** Two agents reporting the same underlying issue in their own words. */
const correctnessDuplicate = makeFinding({
  category: "correctness",
  title: "Admin check assigns instead of comparing",
});
const securityDuplicate = makeFinding({
  category: "security",
  title: "Broken admin gate grants access to every user",
  explanation:
    "Because the condition assigns rather than compares, any user is treated as an admin.",
});

/** What a good synthesiser would return for the duplicates above. */
const combinedFinding = makeFinding({
  category: "security",
  severity: "high",
  title: "Admin gate always passes: assignment instead of comparison",
  explanation:
    "The if condition assigns true to user.isAdmin instead of comparing, so every user is treated as an admin.",
  confidence: 0.95,
});

/** One provider-level call as the SDK assembled it. */
interface CreateParams {
  prompt: { role?: string; content?: unknown }[];
  tools?: unknown[];
}

/** The user text of one recorded call, joined across its parts. */
function userTextOf(call: CreateParams | undefined): string {
  const user = (call?.prompt ?? []).find((entry) => entry.role === "user");
  const parts = (user?.content ?? []) as { type: string; text?: string }[];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** The system instructions of one recorded call. */
function systemOf(call: CreateParams | undefined): string {
  const system = (call?.prompt ?? []).find((entry) => entry.role === "system");
  return String((system?.content as string | undefined) ?? "");
}

/** One scripted response: text, optionally with explicit token usage. */
type ScriptedResponse =
  | string
  | Error
  | { text: string; inputTokens: number; outputTokens: number };

/**
 * Each entry is the next response's text, or an Error to reject with.
 * Captures every create() params object for assertions.
 */
function makeTextModel(script: readonly ScriptedResponse[]) {
  const queue = [...script];
  const calls: CreateParams[] = [];
  const model = new MockLanguageModelV4({
    provider: "test-provider",
    modelId: "test-model",
    doGenerate: (async (options: CreateParams) => {
      calls.push(options);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("fake model client ran out of scripted responses");
      }
      if (next instanceof Error) {
        throw next;
      }
      const scripted =
        typeof next === "string"
          ? { text: next, inputTokens: 1, outputTokens: 1 }
          : next;
      return {
        content: [{ type: "text", text: scripted.text }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: {
            total: scripted.inputTokens,
            noCache: scripted.inputTokens,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: {
            total: scripted.outputTokens,
            text: scripted.outputTokens,
            reasoning: 0,
          },
        },
        warnings: [],
      };
    }) as unknown as MockLanguageModelV4["doGenerate"],
  });
  return { model: model as ReviewModel, calls };
}

describe("createSynthesiser", () => {
  it("combines duplicates across agents into the model's single refined finding", async () => {
    const { model } = makeTextModel([finalFindingsJson([combinedFinding])]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    const { findings } = await synthesiser.synthesise([
      correctnessDuplicate,
      securityDuplicate,
    ]);

    expect(findings).toEqual([combinedFinding]);
  });

  it("reports the single model call's token usage on the result (spec §26)", async () => {
    const { model } = makeTextModel([
      {
        text: finalFindingsJson([combinedFinding]),
        inputTokens: 321,
        outputTokens: 45,
      },
    ]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    const { usage } = await synthesiser.synthesise([
      correctnessDuplicate,
      securityDuplicate,
    ]);

    expect(usage).toEqual({
      inputTokens: 321,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 45,
    });
  });

  it("makes exactly one single-turn model call with no tools", async () => {
    const { model, calls } = makeTextModel([finalFindingsJson([combinedFinding])]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    await synthesiser.synthesise([correctnessDuplicate, securityDuplicate]);

    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.prompt ?? [];
    expect(systemOf(calls[0])).toBe(SYNTHESIS_SYSTEM_PROMPT);
    expect(calls[0]?.tools ?? []).toHaveLength(0);
    expect(prompt.filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it("sends every well-formed candidate to the model as untrusted data", async () => {
    const { model, calls } = makeTextModel([finalFindingsJson([combinedFinding])]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    await synthesiser.synthesise([correctnessDuplicate, securityDuplicate]);

    const text = userTextOf(calls[0]);
    expect(text).toContain(correctnessDuplicate.title);
    expect(text).toContain(securityDuplicate.title);
    // Candidate findings are wrapped as data, not instructions.
    expect(text).toContain("<candidate_findings>");
    expect(text).toContain("</candidate_findings>");
    expect(text).toMatch(/untrusted/i);
  });

  it("excludes malformed candidates from the synthesis input", async () => {
    const { model, calls } = makeTextModel([finalFindingsJson([combinedFinding])]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    await synthesiser.synthesise([
      correctnessDuplicate,
      { file: "x.ts", title: "malformed-marker", confidence: 5 },
    ]);

    const text = userTextOf(calls[0]);
    expect(text).toContain(correctnessDuplicate.title);
    expect(text).not.toContain("malformed-marker");
  });

  it("propagates the model's weak-finding removal", async () => {
    const strong = makeFinding();
    const weak = makeFinding({
      line: 43,
      severity: "low",
      title: "Possible unclear naming in the admin check",
      confidence: 0.72,
    });
    const { model } = makeTextModel([finalFindingsJson([strong])]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    const { findings } = await synthesiser.synthesise([strong, weak]);

    expect(findings).toEqual([strong]);
  });

  it("propagates the model's severity corrections", async () => {
    const overstated = makeFinding({ severity: "high" });
    const corrected = makeFinding({ severity: "medium" });
    const { model } = makeTextModel([finalFindingsJson([corrected])]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    const { findings } = await synthesiser.synthesise([overstated]);

    expect(findings).toEqual([corrected]);
    expect(findings[0]?.severity).toBe("medium");
  });

  it("skips the model call entirely when there are no candidates, reporting zero usage", async () => {
    const { model, calls } = makeTextModel([]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    const result = await synthesiser.synthesise([]);

    expect(result).toEqual({
      findings: [],
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
    });
    expect(calls).toHaveLength(0);
  });

  it("skips the model call when no candidate is well-formed", async () => {
    const { model, calls } = makeTextModel([]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    const result = await synthesiser.synthesise([
      { nonsense: true },
      "not a finding",
    ]);

    expect(result).toEqual({
      findings: [],
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects with SynthesisError when the model output contains no JSON", async () => {
    const { model } = makeTextModel(["I refined the findings for you."]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    await expect(
      synthesiser.synthesise([correctnessDuplicate]),
    ).rejects.toThrowError(SynthesisError);
  });

  it("rejects with SynthesisError when the model output fails schema validation", async () => {
    const { model } = makeTextModel([
      JSON.stringify({ findings: [{ file: "", confidence: 2 }] }),
    ]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    await expect(
      synthesiser.synthesise([correctnessDuplicate]),
    ).rejects.toThrowError(SynthesisError);
  });

  it("propagates model API errors to the caller", async () => {
    const { model } = makeTextModel([new Error("model provider unavailable")]);
    const synthesiser = createSynthesiser({ model, agents: configuredAgents });

    await expect(
      synthesiser.synthesise([correctnessDuplicate]),
    ).rejects.toThrowError("model provider unavailable");
  });
});

describe("buildSynthesisSystemPrompt", () => {
  it("names the agent set it was built for, whatever its size", () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toContain(
      "3 review agents — Correctness, Security, and Architecture —",
    );
    expect(SYNTHESIS_SYSTEM_PROMPT).toContain(
      '"category" is "correctness" | "security" | "architecture"',
    );
  });

  it("agrees with itself on a configured agent set", () => {
    const prompt = buildSynthesisSystemPrompt([
      {
        category: "performance",
        role: "Performance reviewer",
        focus: "Review ONLY for performance problems.",
      },
      {
        category: "data-access",
        role: "Data access reviewer",
        focus: "Review ONLY for data-access problems.",
      },
    ]);

    expect(prompt).toContain("2 review agents — Performance and Data access —");
    expect(prompt).toContain('"category" is "performance" | "data-access"');
    // The example finding must use a category the contract allows.
    expect(prompt).toContain('"category": "performance"');
  });

  it("reads naturally with a single agent", () => {
    const prompt = buildSynthesisSystemPrompt([
      {
        category: "security",
        role: "Security reviewer",
        focus: "Review ONLY for security problems.",
      },
    ]);

    expect(prompt).toContain("1 review agent — Security — has proposed");
  });
});

describe("the synthesis prompt's fixed content", () => {
  it("carries the spec §16 responsibilities", () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/duplicate/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/overlap/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/severity/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/speculative/i);
  });

  it("carries the spec §21 hardening posture over finding text", () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/untrusted/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/data/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/never instructions/i);
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/only output is/i);
  });

  it("forbids inventing findings the agents never proposed", () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/never invent/i);
  });
});

describe("buildSynthesisMessage", () => {
  it("embeds the findings as JSON inside the untrusted-data tag", () => {
    const message = buildSynthesisMessage([correctnessDuplicate]);

    const embedded = /<candidate_findings>\n([\s\S]*)\n<\/candidate_findings>/.exec(
      message,
    );
    expect(embedded).not.toBeNull();
    expect(JSON.parse(embedded?.[1] ?? "")).toEqual([correctnessDuplicate]);
  });
});

describe("a pre-resolved synthesis prompt", () => {
  it("is used in place of the in-code prompt", async () => {
    const injected = "INJECTED SYNTHESIS SYSTEM PROMPT";
    const { model, calls } = makeTextModel([finalFindingsJson([combinedFinding])]);
    const synthesiser = createSynthesiser({
      model,
      agents: configuredAgents,
      systemPrompt: injected,
    });

    await synthesiser.synthesise([correctnessDuplicate, securityDuplicate]);

    expect(systemOf(calls[0])).toBe(injected);
  });
});
