/**
 * Agent configuration, the only place a run's agents come from. Every failure
 * mode must throw rather than review with fewer agents than intended.
 */
import { describe, expect, it } from "vitest";

import { repositoryAgent, repositoryAgents } from "../agent-test-support.js";
import { resolveAgentDefinitions } from "./agent-set.js";
import { buildSynthesisSystemPrompt } from "./synthesiser.js";
import {
  DEFAULT_AGENT_CONFIG_PATH,
  AgentConfigError,
  loadAgentDefinitions,
  parseAgentConfig,
} from "./config.js";
import { buildReviewSystemPrompt, agentPromptKey } from "./definition.js";
import { inCodePrompts } from "../prompts.js";

const PATH = "config.yml";

const performanceYaml = `
agents:
  - category: performance
    role: Performance reviewer
    focus: |
      Review ONLY for performance problems.
`;

/** The categories a config document defines, in order. */
function categories(source: string): string[] {
  return parseAgentConfig(source, PATH).map((agent) => agent.category);
}

describe("parseAgentConfig", () => {
  it("returns the agents in the order they are written", () => {
    expect(
      categories(`${performanceYaml}  - category: security
    role: Security reviewer
    focus: Review ONLY for security problems.
`),
    ).toEqual(["performance", "security"]);
  });

  it("keeps an optional contextGuidance and omits it otherwise", () => {
    const [plain] = parseAgentConfig(performanceYaml, PATH);
    expect(plain?.contextGuidance).toBeUndefined();

    const [guided] = parseAgentConfig(
      `${performanceYaml}    contextGuidance: Read the neighbours first.\n`,
      PATH,
    );
    expect(guided?.contextGuidance).toBe("Read the neighbours first.");
  });

  it("rejects an empty document, which would define no agents", () => {
    for (const source of ["", "# just a comment\n", "agents: []\n"]) {
      expect(() => parseAgentConfig(source, PATH)).toThrow(AgentConfigError);
    }
  });

  it("rejects YAML that does not parse, naming the file", () => {
    expect(() => parseAgentConfig("agents: [\n", PATH)).toThrow(/config\.yml/);
  });

  it("rejects an agent missing its role or focus", () => {
    expect(() =>
      parseAgentConfig("agents:\n  - category: performance\n", PATH),
    ).toThrow(/role/);
  });

  it("rejects a category that is not a lowercase slug", () => {
    for (const bad of ["Performance", "perf ormance", "9lives"]) {
      expect(() =>
        parseAgentConfig(performanceYaml.replace("performance", bad), PATH),
      ).toThrow(AgentConfigError);
    }
  });

  it("rejects the reserved synthesis and all names", () => {
    for (const reserved of ["synthesis", "all"]) {
      expect(() =>
        parseAgentConfig(performanceYaml.replace("performance", reserved), PATH),
      ).toThrow(/reserved/);
    }
  });

  it("rejects the same agent defined twice", () => {
    // One of the two would silently win, and prompt keys would collide.
    expect(() =>
      parseAgentConfig(`${performanceYaml}${performanceYaml.replace("agents:\n", "")}`, PATH),
    ).toThrow(/twice/);
  });

  it("rejects an unknown top-level key rather than ignoring it", () => {
    // A typo'd key would silently review with the wrong agents.
    expect(() =>
      parseAgentConfig("agent:\n  - category: performance\n", PATH),
    ).toThrow(AgentConfigError);
  });

  it("rejects an unknown key within an agent", () => {
    // contextGuidance is optional, so a misspelling would drop the
    // agent's evidence requirement without a word.
    for (const typo of ["contextguidance", "context_guidance", "guidance"]) {
      expect(() =>
        parseAgentConfig(`${performanceYaml}    ${typo}: Read the neighbours first.\n`, PATH),
      ).toThrow(AgentConfigError);
    }
  });
});

describe("parseAgentConfig: path filters", () => {
  const gatedYaml = `${performanceYaml}    paths:
      - "packages/**"
      - "!**/*.test.ts"
`;

  it("keeps an agent's paths and omits them otherwise", () => {
    expect(parseAgentConfig(performanceYaml, PATH)[0]?.paths).toBeUndefined();
    expect(parseAgentConfig(gatedYaml, PATH)[0]?.paths).toEqual([
      "packages/**",
      "!**/*.test.ts",
    ]);
  });

  it("gates a built-in through the `agent:` form", () => {
    const [agent] = parseAgentConfig(
      'agents:\n  - agent: security\n    paths: ["packages/github/**"]\n',
      PATH,
    );

    expect(agent?.category).toBe("security");
    expect(agent?.role).toBe("Security reviewer");
    expect(agent?.paths).toEqual(["packages/github/**"]);
  });

  it("accepts the `agent:` form without paths, like the bare string", () => {
    expect(parseAgentConfig("agents:\n  - agent: security\n", PATH)).toEqual(
      parseAgentConfig("agents:\n  - security\n", PATH),
    );
  });

  it("names the built-ins when the `agent:` form misspells one", () => {
    expect(() =>
      parseAgentConfig("agents:\n  - agent: securty\n", PATH),
    ).toThrow(/unknown built-in agent: "securty"/);
  });

  it("rejects an unknown key beside `agent:`", () => {
    // Otherwise `path:` would drop the gate and run the agent always.
    expect(() =>
      parseAgentConfig('agents:\n  - agent: security\n    path: ["src/**"]\n', PATH),
    ).toThrow(AgentConfigError);
  });

  it("rejects paths that would match nothing", () => {
    // Each of these retires the agent in silence otherwise.
    for (const paths of ['[]', '["!**/*.md"]', '["/packages/**"]', '["./src/**"]']) {
      expect(() =>
        parseAgentConfig(`${performanceYaml}    paths: ${paths}\n`, PATH),
      ).toThrow(AgentConfigError);
    }
  });
});

describe("loadAgentDefinitions", () => {
  it("reads the default path", async () => {
    const paths: string[] = [];

    await loadAgentDefinitions({
      readFile: async (path) => {
        paths.push(path);
        return performanceYaml;
      },
    });

    expect(paths).toEqual([DEFAULT_AGENT_CONFIG_PATH]);
  });

  it("reads the path it is given", async () => {
    const paths: string[] = [];

    await loadAgentDefinitions({
      readFile: async (path) => {
        paths.push(path);
        return performanceYaml;
      },
      path: "config/agents.yml",
    });

    expect(paths).toEqual(["config/agents.yml"]);
  });

  it("fails with an actionable message when no config exists", async () => {
    // Nothing ships by default, so this must never quietly review nothing.
    await expect(loadAgentDefinitions({ readFile: async () => undefined })).rejects.toThrow(
      /No review agents are configured/,
    );
    await expect(loadAgentDefinitions({ readFile: async () => undefined })).rejects.toThrow(
      /agents:/,
    );
  });

  it("throws rather than reviewing with the wrong agents", async () => {
    await expect(
      loadAgentDefinitions({ readFile: async () => "agents: not-a-list\n" }),
    ).rejects.toThrow(AgentConfigError);
  });
});

/** The whole point: a repository whose agents share nothing with this one. */
describe("a repository configuring one agent of its own", () => {
  const onlyPerformance = `
agents:
  - category: performance
    role: Performance reviewer
    focus: |
      Review ONLY for performance problems. Do NOT report style.
`;

  it("carries that agent through selection, prompts, and synthesis", async () => {
    const agents = await loadAgentDefinitions({ readFile: async () => onlyPerformance });

    expect(agents.map((agent) => agent.category)).toEqual(["performance"]);
    expect(Object.keys(inCodePrompts(agents)).map(agentPromptKey)).toEqual([
      "performance_system",
      "synthesis_system",
    ]);
    expect(inCodePrompts(agents)["performance"]).toContain(
      '"category": always "performance"',
    );
    expect(buildSynthesisSystemPrompt(agents)).toContain(
      "1 review agent — Performance — has proposed",
    );
    expect(
      resolveAgentDefinitions("all", agents).map((agent) => agent.category),
    ).toEqual(["performance"]);
    expect(() => resolveAgentDefinitions("security", agents)).toThrow(
      /Unknown review agent: security/,
    );
  });
});

/**
 * The prose in .github/pr-review-agents.yml is configuration, so what it must
 * say belongs here rather than in the engine's own tests.
 */
describe("this repository's own configuration", () => {
  const focusOf = (category: string): string =>
    buildReviewSystemPrompt(repositoryAgent(category));

  it("parses, and defines the agents the docs describe", () => {
    // The README points newcomers at this file as their starting point.
    expect(repositoryAgents().map((agent) => agent.category)).toEqual([
      "correctness",
      "security",
      "architecture",
    ]);
  });

  it("aims the security agent at the spec §10 targets", () => {
    const system = focusOf("security");

    for (const target of [
      /authentication/i,
      /authorisation|authorization/i,
      /cross-tenant/i,
      /injection/i,
      /secret/i,
      /user input/i,
      /log/i,
      /privilege/i,
    ]) {
      expect(system).toMatch(target);
    }
    expect(system).toMatch(/no finding.*(over|rather than).*speculative/is);
  });

  it("aims the architecture agent at the spec §11 targets", () => {
    const system = focusOf("architecture");

    for (const target of [
      /abstraction/i,
      /duplicat/i,
      /dependenc/i,
      /boundar/i,
      /existing pattern/i,
      /business logic/i,
    ]) {
      expect(system).toMatch(target);
    }
    // An architectural claim needs the surrounding code, not just the diff.
    expect(system).toMatch(
      /(get_file|search_repository).*(before|prior to).*claim|before.*claim.*(get_file|search_repository)/is,
    );
    expect(system).toMatch(/surrounding repository context/i);
  });
});
