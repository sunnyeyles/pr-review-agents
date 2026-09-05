/**
 * Agent selection over the shared runtime. There is no built-in agent set, so
 * fixtures come from .github/pr-review-agents.yml.
 */
import { createCapturingLogger } from "@pr-review/logging";
import type { FindingCategory } from "@pr-review/schemas";
import { describe, expect, it } from "vitest";

import {
  ALL_AGENTS,
  buildReviewSystemPrompt,
  type AgentDefinition,
} from "./definition.js";
import {
  createReviewAgents,
  gateAgentsByPaths,
  resolveAgentDefinitions,
} from "./agent-set.js";
import { createReviewAgent, type ReviewAgentDeps } from "./runtime.js";
import { reviewPromptContractProblems } from "../prompts.js";
import {
  context,
  finalFindingsJson,
  makeFinding,
  makeGithub,
  makeModel,
  message,
  repositoryAgent,
  repositoryAgents,
  textBlock,
} from "../agent-test-support.js";

const configuredAgents = repositoryAgents();
const correctnessAgent = repositoryAgent("correctness");
const securityAgent = repositoryAgent("security");
const architectureAgent = repositoryAgent("architecture");

const SIX_TOOL_NAMES = [
  "get_base_file",
  "get_diff",
  "get_file",
  "get_pull_request",
  "list_changed_files",
  "search_repository",
];

function makeDeps(responses: ReturnType<typeof message>[]) {
  const { model, doGenerate, calls } = makeModel(responses);
  const deps: ReviewAgentDeps = {
    model,
    github: makeGithub(),
    logger: createCapturingLogger().logger,
  };
  return { deps, create: doGenerate, calls };
}

/**
 * The rules live in reviewPromptContractProblems so one definition
 * governs both shipped prompts and ones fetched from Langfuse.
 */
function expectInjectionHardened(system: string, category: FindingCategory): void {
  expect(reviewPromptContractProblems(system, category)).toEqual([]);
}

describe("agent names", () => {
  it("names each agent after its agent", () => {
    const { deps } = makeDeps([]);

    for (const agent of configuredAgents) {
      expect(createReviewAgent(agent, deps).name).toBe(agent.category);
    }
  });

  it("createReviewAgents builds one agent per agent, in configuration order", () => {
    const { deps } = makeDeps([]);

    expect(createReviewAgents(deps, configuredAgents).map((agent) => agent.name)).toEqual(
      configuredAgents.map((agent) => agent.category),
    );
  });

  it("createReviewAgents builds only the agents it is given", () => {
    const { deps } = makeDeps([]);

    expect(
      createReviewAgents(deps, [architectureAgent]).map((agent) => agent.name),
    ).toEqual(["architecture"]);
  });
});

describe("resolveAgentDefinitions", () => {
  const names = (selection: string): string[] =>
    resolveAgentDefinitions(selection, configuredAgents).map((agent) => agent.category);

  it("selects over the agent set it is given, not this repository's", () => {
    const performanceAgent = {
      category: "performance",
      role: "Performance reviewer",
      focus: "Review ONLY for performance problems.",
    };
    const available = [correctnessAgent, performanceAgent];

    expect(
      resolveAgentDefinitions("performance", available).map((agent) => agent.category),
    ).toEqual(["performance"]);
    expect(
      resolveAgentDefinitions(ALL_AGENTS, available).map((agent) => agent.category),
    ).toEqual(["correctness", "performance"]);
    // An agent absent from the given set is unknown, not implied.
    expect(() => resolveAgentDefinitions("security", available)).toThrow(
      /Unknown review agent: security/,
    );
  });

  it("treats an absent selection and an explicit `all` alike", () => {
    // An unset action input arrives as "", so the two must not differ.
    expect(names("")).toEqual(["correctness", "security", "architecture"]);
    expect(names("   ")).toEqual(["correctness", "security", "architecture"]);
    expect(names(ALL_AGENTS)).toEqual([
      "correctness",
      "security",
      "architecture",
    ]);
    expect(names("ALL")).toEqual(["correctness", "security", "architecture"]);
  });

  it("selects a single agent", () => {
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

  it("selects every agent when all appears alongside a name", () => {
    // The error used to name "all" in its own list of valid values.
    expect(resolveAgentDefinitions("all,security", configuredAgents)).toEqual([...configuredAgents]);
    expect(resolveAgentDefinitions("security,all", configuredAgents)).toEqual([...configuredAgents]);
  });

  it("still rejects a typo sitting next to all", () => {
    expect(() => resolveAgentDefinitions("all,secuirty", configuredAgents)).toThrow(
      /Unknown review agent: secuirty/,
    );
  });

  it("rejects an unknown name instead of silently dropping it", () => {
    // A dropped name would look exactly like a clean review.
    expect(() => resolveAgentDefinitions("secuirty", configuredAgents)).toThrow(
      /Unknown review agent: secuirty/,
    );
    expect(() => resolveAgentDefinitions("secuirty", configuredAgents)).toThrow(/architecture/);
  });

  it("rejects a selection that names nothing at all", () => {
    expect(() => resolveAgentDefinitions(",", configuredAgents)).toThrow(/No review agents selected/);
  });

  it("drops the paths of an agent named explicitly, so its gate cannot hold", () => {
    const gated = [
      correctnessAgent,
      { ...securityAgent, paths: ["packages/github/**"] },
    ];

    expect(resolveAgentDefinitions("security", gated)).toEqual([securityAgent]);
  });

  it("keeps the paths of every agent when the selection is `all`", () => {
    const security = { ...securityAgent, paths: ["packages/github/**"] };

    for (const selection of ["", ALL_AGENTS, "all,security"]) {
      expect(
        resolveAgentDefinitions(selection, [correctnessAgent, security]),
        selection,
      ).toEqual([correctnessAgent, security]);
    }
  });
});

describe("the composed agent prompt", () => {
  it("stamps each agent's own category on its output contract", () => {
    // Losing the stamp fails silently: the runtime discards findings
    // whose category is not the agent's own.
    for (const agent of configuredAgents) {
      expect(buildReviewSystemPrompt(agent)).toContain(
        `"category": always "${agent.category}"`,
      );
    }
  });

  it("carries the §21 prompt-injection hardening for every agent", () => {
    for (const agent of configuredAgents) {
      expectInjectionHardened(buildReviewSystemPrompt(agent), agent.category);
    }
  });
});

describe("per-agent model", () => {
  const finalResponse = (): ReturnType<typeof message> =>
    message([textBlock(finalFindingsJson([]))], "end_turn");

  it("builds an agent's own model and leaves the rest on the default", async () => {
    const fallback = makeModel([finalResponse()]);
    const override = makeModel([finalResponse()], "test-provider", "override-model");
    const built: string[] = [];
    const deps: ReviewAgentDeps = {
      model: fallback.model,
      createModel: (modelId) => {
        built.push(modelId);
        return override.model;
      },
      github: makeGithub(),
      logger: createCapturingLogger().logger,
    };

    const agents = createReviewAgents(deps, [
      { ...securityAgent, model: "override-model" },
      correctnessAgent,
    ]);
    for (const agent of agents) {
      await agent.run(context);
    }

    expect(built).toEqual(["override-model"]);
    expect(override.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default model when no factory is configured", async () => {
    const fallback = makeModel([finalResponse()]);
    const deps: ReviewAgentDeps = {
      model: fallback.model,
      github: makeGithub(),
      logger: createCapturingLogger().logger,
    };

    const [agent] = createReviewAgents(deps, [
      { ...securityAgent, model: "override-model" },
    ]);
    await agent?.run(context);

    expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("prompt wiring", () => {
  it("each agent sends its own agent prompt to the model", async () => {
    for (const agent of configuredAgents) {
      const { deps, calls } = makeDeps([
        message([textBlock(finalFindingsJson([]))], "end_turn"),
      ]);

      await createReviewAgent(agent, deps).run(context);

      const system = (calls[0]?.prompt ?? []).find(
        (entry) => (entry as { role?: string }).role === "system",
      );
      expect((system as { content?: string } | undefined)?.content).toBe(
        buildReviewSystemPrompt(agent),
      );
    }
  });

  it("every agent exposes the identical six read-only tools", async () => {
    for (const agent of configuredAgents) {
      const { deps, calls } = makeDeps([
        message([textBlock(finalFindingsJson([]))], "end_turn"),
      ]);

      await createReviewAgent(agent, deps).run(context);

      const toolNames = (calls[0]?.tools ?? [])
        .map((tool) => String((tool as { name?: string }).name))
        .sort();
      expect(toolNames).toEqual(SIX_TOOL_NAMES);
    }
  });
});

describe("this repository's agents over one PR context", () => {
  it("runs concurrently and each returns findings in its own category", async () => {
    // Each fake call resolves only once all three agents have called,
    // so sequential execution would deadlock this test.
    const started: string[] = [];
    let releaseAll = (): void => {};
    const allStarted = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    function gatedAgent(agent: (typeof configuredAgents)[number]) {
      const finding = makeFinding(agent.category);
      const { model, doGenerate } = makeModel([]);
      doGenerate.mockImplementation(async () => {
        started.push(agent.category);
        if (started.length === 3) {
          releaseAll();
        }
        await allStarted;
        return message([textBlock(finalFindingsJson([finding]))], "end_turn");
      });
      const deps: ReviewAgentDeps = {
        model,
        github: makeGithub(),
        logger: createCapturingLogger().logger,
      };
      return { agent: createReviewAgent(agent, deps), finding };
    }

    const correctness = gatedAgent(correctnessAgent);
    const security = gatedAgent(securityAgent);
    const architecture = gatedAgent(architectureAgent);

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

describe("gateAgentsByPaths", () => {
  function agent(category: string, paths?: string[]): AgentDefinition {
    return {
      category,
      role: `${category} reviewer`,
      focus: `Review only for ${category} problems.`,
      ...(paths === undefined ? {} : { paths }),
    };
  }

  it("runs an agent that declares no paths, whatever changed", () => {
    const agents = [agent("correctness")];

    expect(gateAgentsByPaths(agents, ["README.md"])).toEqual({
      active: agents,
      skipped: [],
    });
  });

  it("wakes an agent on a single matching file", () => {
    const security = agent("security", ["packages/github/**"]);

    const gated = gateAgentsByPaths(
      [security],
      ["README.md", "packages/github/src/client.ts"],
    );

    expect(gated.active).toEqual([security]);
    expect(gated.skipped).toEqual([]);
  });

  it("skips an agent nothing matched, recording what it waited for", () => {
    const paths = ["packages/github/**", "**/auth/**"];

    const gated = gateAgentsByPaths([agent("security", paths)], ["README.md"]);

    expect(gated.active).toEqual([]);
    expect(gated.skipped).toEqual([{ agent: "security", paths }]);
  });

  it("keeps the configured order in both halves", () => {
    // Agent order is the order findings reach the synthesiser, so the
    // gate must not reorder what it lets through.
    const agents = [
      agent("correctness"),
      agent("security", ["packages/github/**"]),
      agent("architecture"),
      agent("docs-drift", ["docs/**"]),
    ];

    const gated = gateAgentsByPaths(agents, ["src/index.ts"]);

    expect(gated.active.map((one) => one.category)).toEqual([
      "correctness",
      "architecture",
    ]);
    expect(gated.skipped.map((one) => one.agent)).toEqual([
      "security",
      "docs-drift",
    ]);
  });

  it("skips every agent when a pull request changed nothing", () => {
    const gated = gateAgentsByPaths([agent("security", ["packages/**"])], []);

    expect(gated.active).toEqual([]);
    expect(gated.skipped.map((one) => one.agent)).toEqual(["security"]);
  });
});
