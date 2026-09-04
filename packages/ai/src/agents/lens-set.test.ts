/**
 * Lens selection, and this repository's configured lenses over the shared
 * agent runtime. There is no built-in lens set, so the fixtures here come
 * from .github/pr-review.yml. Model calls are scripted fakes.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { createCapturingLogger } from "@pr-review/logging";
import type { FindingCategory } from "@pr-review/schemas";
import { describe, expect, it, vi } from "vitest";

import { ALL_LENSES, buildReviewSystemPrompt } from "./lens.js";
import { createReviewAgents, resolveReviewLenses } from "./lens-set.js";
import { createReviewAgent, type ReviewAgentDeps } from "./runtime.js";
import { reviewPromptContractProblems } from "../prompts.js";
import {
  context,
  finalFindingsJson,
  makeFinding,
  makeGithub,
  message,
  repositoryLens,
  repositoryLenses,
  systemPromptOf,
  textBlock,
} from "../agent-test-support.js";

const configuredLenses = repositoryLenses();
const correctnessLens = repositoryLens("correctness");
const securityLens = repositoryLens("security");
const architectureLens = repositoryLens("architecture");

const SIX_TOOL_NAMES = [
  "get_base_file",
  "get_diff",
  "get_file",
  "get_pull_request",
  "list_changed_files",
  "search_repository",
];

function makeDeps(responses: Anthropic.Messages.Message[]) {
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
  const deps: ReviewAgentDeps = {
    anthropic: { messages: { create } },
    model: "claude-test-model",
    github: makeGithub(),
    logger: createCapturingLogger().logger,
  };
  return { deps, create };
}

/**
 * The rules live in reviewPromptContractProblems so one definition
 * governs both shipped prompts and ones fetched from Langfuse.
 */
function expectInjectionHardened(system: string, category: FindingCategory): void {
  expect(reviewPromptContractProblems(system, category)).toEqual([]);
}

describe("agent names", () => {
  it("names each agent after its lens", () => {
    const { deps } = makeDeps([]);

    for (const lens of configuredLenses) {
      expect(createReviewAgent(lens, deps).name).toBe(lens.category);
    }
  });

  it("createReviewAgents builds one agent per lens, in configuration order", () => {
    const { deps } = makeDeps([]);

    expect(createReviewAgents(deps, configuredLenses).map((agent) => agent.name)).toEqual(
      configuredLenses.map((lens) => lens.category),
    );
  });

  it("createReviewAgents builds only the lenses it is given", () => {
    const { deps } = makeDeps([]);

    expect(
      createReviewAgents(deps, [architectureLens]).map((agent) => agent.name),
    ).toEqual(["architecture"]);
  });
});

describe("resolveReviewLenses", () => {
  const names = (selection: string): string[] =>
    resolveReviewLenses(selection, configuredLenses).map((lens) => lens.category);

  it("selects over the lens set it is given, not this repository's", () => {
    const performanceLens = {
      category: "performance",
      role: "Performance reviewer",
      focus: "Review ONLY for performance problems.",
    };
    const available = [correctnessLens, performanceLens];

    expect(
      resolveReviewLenses("performance", available).map((lens) => lens.category),
    ).toEqual(["performance"]);
    expect(
      resolveReviewLenses(ALL_LENSES, available).map((lens) => lens.category),
    ).toEqual(["correctness", "performance"]);
    // A lens absent from the given set is unknown, not implied.
    expect(() => resolveReviewLenses("security", available)).toThrow(
      /Unknown review agent: security/,
    );
  });

  it("treats an absent selection and an explicit `all` alike", () => {
    // An unset action input arrives as "", so the two must not differ.
    expect(names("")).toEqual(["correctness", "security", "architecture"]);
    expect(names("   ")).toEqual(["correctness", "security", "architecture"]);
    expect(names(ALL_LENSES)).toEqual([
      "correctness",
      "security",
      "architecture",
    ]);
    expect(names("ALL")).toEqual(["correctness", "security", "architecture"]);
  });

  it("selects a single lens", () => {
    expect(names("architecture")).toEqual(["architecture"]);
  });

  it("returns the subset in spec order, never the caller's order", () => {
    // Agent order decides candidate order in `join`.
    expect(names("architecture,correctness")).toEqual([
      "correctness",
      "architecture",
    ]);
  });

  it("collapses duplicates rather than running an agent twice", () => {
    expect(names("correctness,correctness")).toEqual(["correctness"]);
  });

  it("tolerates whitespace and casing around the names", () => {
    expect(names(" Correctness , SECURITY ")).toEqual([
      "correctness",
      "security",
    ]);
  });

  it("selects every lens when all appears alongside a name", () => {
    // The error used to name "all" in its own list of valid values.
    expect(resolveReviewLenses("all,security", configuredLenses)).toEqual([...configuredLenses]);
    expect(resolveReviewLenses("security,all", configuredLenses)).toEqual([...configuredLenses]);
  });

  it("still rejects a typo sitting next to all", () => {
    expect(() => resolveReviewLenses("all,secuirty", configuredLenses)).toThrow(
      /Unknown review agent: secuirty/,
    );
  });

  it("rejects an unknown name instead of silently dropping it", () => {
    // A dropped name would look exactly like a clean review.
    expect(() => resolveReviewLenses("secuirty", configuredLenses)).toThrow(
      /Unknown review agent: secuirty/,
    );
    expect(() => resolveReviewLenses("secuirty", configuredLenses)).toThrow(/architecture/);
  });

  it("rejects a selection that names nothing at all", () => {
    expect(() => resolveReviewLenses(",", configuredLenses)).toThrow(/No review agents selected/);
  });
});

describe("the composed lens prompt", () => {
  it("stamps each lens's own category on its output contract", () => {
    // Losing the stamp fails silently: the runtime discards findings
    // whose category is not the lens's own.
    for (const lens of configuredLenses) {
      expect(buildReviewSystemPrompt(lens)).toContain(
        `"category": always "${lens.category}"`,
      );
    }
  });

  it("carries the §21 prompt-injection hardening for every lens", () => {
    for (const lens of configuredLenses) {
      expectInjectionHardened(buildReviewSystemPrompt(lens), lens.category);
    }
  });
});

describe("prompt wiring", () => {
  it("each agent sends its own lens prompt to the model", async () => {
    for (const lens of configuredLenses) {
      const { deps, create } = makeDeps([
        message([textBlock(finalFindingsJson([]))], "end_turn"),
      ]);

      await createReviewAgent(lens, deps).run(context);

      expect(systemPromptOf(create.mock.calls[0]?.[0])).toBe(
        buildReviewSystemPrompt(lens),
      );
    }
  });

  it("every lens exposes the identical six read-only tools", async () => {
    for (const lens of configuredLenses) {
      const { deps, create } = makeDeps([
        message([textBlock(finalFindingsJson([]))], "end_turn"),
      ]);

      await createReviewAgent(lens, deps).run(context);

      const toolNames = (create.mock.calls[0]?.[0]?.tools ?? [])
        .map((tool) => tool.name)
        .sort();
      expect(toolNames).toEqual(SIX_TOOL_NAMES);
    }
  });
});

describe("this repository's lenses over one PR context", () => {
  it("runs concurrently and each returns findings in its own category", async () => {
    // Each fake call resolves only once all three agents have called,
    // so sequential execution would deadlock this test.
    const started: string[] = [];
    let releaseAll = (): void => {};
    const allStarted = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    function gatedLensAgent(lens: (typeof configuredLenses)[number]) {
      const finding = makeFinding(lens.category);
      const deps: ReviewAgentDeps = {
        anthropic: {
          messages: {
            create: async () => {
              started.push(lens.category);
              if (started.length === 3) {
                releaseAll();
              }
              await allStarted;
              return message(
                [textBlock(finalFindingsJson([finding]))],
                "end_turn",
              );
            },
          },
        },
        model: "claude-test-model",
        github: makeGithub(),
        logger: createCapturingLogger().logger,
      };
      return { agent: createReviewAgent(lens, deps), finding };
    }

    const correctness = gatedLensAgent(correctnessLens);
    const security = gatedLensAgent(securityLens);
    const architecture = gatedLensAgent(architectureLens);

    const [correctnessFindings, securityFindings, architectureFindings] =
      await Promise.all([
        correctness.agent.run(context),
        security.agent.run(context),
        architecture.agent.run(context),
      ]);

    expect(started).toHaveLength(3);
    expect(correctnessFindings).toEqual([correctness.finding]);
    expect(securityFindings).toEqual([security.finding]);
    expect(architectureFindings).toEqual([architecture.finding]);

    const combined = [
      ...correctnessFindings,
      ...securityFindings,
      ...architectureFindings,
    ];
    expect(
      combined.map((candidate) => (candidate as { category: string }).category),
    ).toEqual(["correctness", "security", "architecture"]);
  }, 5_000);
});
