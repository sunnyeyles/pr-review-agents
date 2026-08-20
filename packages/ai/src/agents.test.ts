/**
 * The three review lenses over the shared agent runtime: names,
 * lens-focused and §21-hardened system prompts, the identical six-tool
 * read-only toolset, and genuinely concurrent execution over one PR
 * context. Model calls are always scripted fakes — no real network.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { createCapturingLogger } from "@pr-review/logging";
import type { FindingCategory } from "@pr-review/schemas";
import { describe, expect, it, vi } from "vitest";

import {
  buildReviewSystemPrompt,
  createReviewAgent,
  type ReviewAgentDeps,
} from "./agent-runtime.js";
import { reviewPromptContractProblems } from "./prompts.js";
import {
  context,
  finalFindingsJson,
  makeFinding,
  makeGithub,
  message,
  textBlock,
} from "./agent-test-support.js";
import {
  architectureLens,
  correctnessLens,
  createReviewAgents,
  reviewLenses,
  securityLens,
} from "./agents.js";

const SECURITY_SYSTEM_PROMPT = buildReviewSystemPrompt(securityLens);
const ARCHITECTURE_SYSTEM_PROMPT = buildReviewSystemPrompt(architectureLens);

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
 * Asserts the prompt-injection hardening and output contract every
 * lens prompt must carry.
 *
 * The rules live in reviewPromptContractProblems rather than here so
 * that ONE definition governs both the prompts this repo ships and the
 * ones fetched from Langfuse. Asserting them separately here is what
 * previously let the remote gate drift weaker than this bar.
 */
function expectInjectionHardened(system: string, category: FindingCategory): void {
  expect(reviewPromptContractProblems(system, category)).toEqual([]);
}

describe("agent names", () => {
  it("names each agent after its lens", () => {
    const { deps } = makeDeps([]);

    for (const lens of reviewLenses) {
      expect(createReviewAgent(lens, deps).name).toBe(lens.category);
    }
  });

  it("createReviewAgents returns the three lenses in spec order", () => {
    const { deps } = makeDeps([]);

    expect(createReviewAgents(deps).map((agent) => agent.name)).toEqual([
      "correctness",
      "security",
      "architecture",
    ]);
  });
});

describe("the Security lens prompt", () => {
  it("focuses on the spec §10 security review targets", () => {
    const system = SECURITY_SYSTEM_PROMPT;

    expect(system).toMatch(/authentication/i);
    expect(system).toMatch(/authorisation|authorization/i);
    expect(system).toMatch(/cross-tenant/i);
    expect(system).toMatch(/injection/i);
    expect(system).toMatch(/secret/i);
    expect(system).toMatch(/user input/i);
    expect(system).toMatch(/log/i);
    expect(system).toMatch(/privilege/i);
  });

  it("explicitly prefers no finding over a speculative one", () => {
    expect(SECURITY_SYSTEM_PROMPT).toMatch(
      /no finding.*(over|rather than).*speculative/is,
    );
  });

  it("stamps the security category on the output contract", () => {
    expect(SECURITY_SYSTEM_PROMPT).toMatch(/"category": always "security"/);
  });

  it("carries the same §21 prompt-injection hardening as Correctness", () => {
    expectInjectionHardened(SECURITY_SYSTEM_PROMPT, "security");
  });
});

describe("the Architecture lens prompt", () => {
  it("focuses on the spec §11 architecture review targets", () => {
    const system = ARCHITECTURE_SYSTEM_PROMPT;

    expect(system).toMatch(/abstraction/i);
    expect(system).toMatch(/duplicat/i);
    expect(system).toMatch(/dependenc/i);
    expect(system).toMatch(/boundar/i);
    expect(system).toMatch(/existing pattern/i);
    expect(system).toMatch(/business logic/i);
  });

  it("requires retrieving surrounding repository context before architectural claims", () => {
    expect(ARCHITECTURE_SYSTEM_PROMPT).toMatch(
      /(get_file|search_repository).*(before|prior to).*claim|before.*claim.*(get_file|search_repository)/is,
    );
    expect(ARCHITECTURE_SYSTEM_PROMPT).toMatch(/surrounding repository context/i);
  });

  it("stamps the architecture category on the output contract", () => {
    expect(ARCHITECTURE_SYSTEM_PROMPT).toMatch(/"category": always "architecture"/);
  });

  it("carries the same §21 prompt-injection hardening as Correctness", () => {
    expectInjectionHardened(ARCHITECTURE_SYSTEM_PROMPT, "architecture");
  });
});

describe("prompt wiring", () => {
  it("each agent sends its own lens prompt to the model", async () => {
    for (const lens of reviewLenses) {
      const { deps, create } = makeDeps([
        message([textBlock(finalFindingsJson([]))], "end_turn"),
      ]);

      await createReviewAgent(lens, deps).run(context);

      expect(create.mock.calls[0]?.[0]?.system).toBe(
        buildReviewSystemPrompt(lens),
      );
    }
  });

  it("every lens exposes the identical six read-only tools", async () => {
    for (const lens of reviewLenses) {
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

describe("three lenses over one PR context", () => {
  it("runs concurrently and each returns findings in its own category", async () => {
    // Each fake model call resolves only once ALL THREE agents have
    // issued their first call: if the agents ran sequentially instead
    // of concurrently, the first agent would wait forever and the test
    // would time out.
    const started: string[] = [];
    let releaseAll = (): void => {};
    const allStarted = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    function gatedLensAgent(lens: (typeof reviewLenses)[number]) {
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
