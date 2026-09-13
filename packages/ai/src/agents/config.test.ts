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
import {
  ALL_AGENTS,
  buildReviewSystemPrompt,
  agentPromptKey,
} from "./definition.js";
import { BUILT_IN_AGENT_NAMES } from "./specialists/index.js";
import { inCodePrompts } from "../prompts.js";

const PATH = "config.yml";

const securityYaml = `
agents:
  - agent: security
`;

/** The categories a config document names, in order. */
function categories(source: string): string[] {
  return parseAgentConfig(source, PATH).map((agent) => agent.category);
}

describe("the built-in agents", () => {
  it("ships the specialists the configuration may name", () => {
    expect([...BUILT_IN_AGENT_NAMES]).toEqual([
      "security",
      "correctness",
      "performance",
      "test-coverage",
      "docs-drift",
    ]);
  });

  it("gives every built-in a slug that is not a reserved name", () => {
    for (const name of BUILT_IN_AGENT_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(name).not.toBe(ALL_AGENTS);
    }
  });
});

describe("parseAgentConfig", () => {
  it("returns the agents in the order they are named", () => {
    expect(categories("agents:\n  - docs-drift\n  - security\n")).toEqual([
      "docs-drift",
      "security",
    ]);
  });

  it("carries the built-in's own contextGuidance, and omits it otherwise", () => {
    expect(parseAgentConfig("agents:\n  - security\n", PATH)[0]?.contextGuidance)
      .toBeUndefined();
    expect(
      parseAgentConfig("agents:\n  - docs-drift\n", PATH)[0]?.contextGuidance,
    ).toMatch(/retrieve the documentation/i);
  });

  it("keeps an optional model and omits it otherwise", () => {
    expect(parseAgentConfig(securityYaml, PATH)[0]?.model).toBeUndefined();

    const [overridden] = parseAgentConfig(
      `${securityYaml}    model: claude-haiku-4-5\n`,
      PATH,
    );
    expect(overridden?.model).toBe("claude-haiku-4-5");
  });

  it("rejects an empty model, which would name no model at all", () => {
    for (const value of ['""', '"   "']) {
      expect(() =>
        parseAgentConfig(`${securityYaml}    model: ${value}\n`, PATH),
      ).toThrow(AgentConfigError);
    }
  });

  it("rejects an empty document, which would name no agents", () => {
    for (const source of ["", "# just a comment\n", "agents: []\n"]) {
      expect(() => parseAgentConfig(source, PATH)).toThrow(AgentConfigError);
    }
  });

  it("rejects YAML that does not parse, naming the file", () => {
    expect(() => parseAgentConfig("agents: [\n", PATH)).toThrow(/config\.yml/);
  });

  it("rejects an entry defining an agent instead of naming one", () => {
    // The form was removed; the message must say so rather than list keys.
    expect(() =>
      parseAgentConfig(
        "agents:\n  - category: performance\n    role: Performance reviewer\n    focus: Review ONLY for performance.\n",
        PATH,
      ),
    ).toThrow(/does not name a built-in agent/);
  });

  it("names the built-ins when an entry misspells one", () => {
    expect(() => parseAgentConfig("agents:\n  - securty\n", PATH)).toThrow(
      /unknown built-in agent: "securty"/,
    );
  });

  it("rejects the same agent named twice", () => {
    // One of the two would silently win, and prompt keys would collide.
    expect(() =>
      parseAgentConfig("agents:\n  - security\n  - agent: security\n", PATH),
    ).toThrow(/twice/);
  });

  it("rejects an unknown top-level key rather than ignoring it", () => {
    // A typo'd key would silently review with the wrong agents.
    expect(() => parseAgentConfig("agent:\n  - security\n", PATH)).toThrow(
      AgentConfigError,
    );
  });
});

describe("parseAgentConfig: path filters", () => {
  it("keeps an agent's paths and omits them otherwise", () => {
    expect(parseAgentConfig(securityYaml, PATH)[0]?.paths).toBeUndefined();
    expect(
      parseAgentConfig(
        `${securityYaml}    paths:\n      - "packages/**"\n      - "!**/*.test.ts"\n`,
        PATH,
      )[0]?.paths,
    ).toEqual(["packages/**", "!**/*.test.ts"]);
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

  it("rejects an unknown key beside `agent:`", () => {
    // Otherwise `path:` would drop the gate and run the agent always.
    expect(() =>
      parseAgentConfig('agents:\n  - agent: security\n    path: ["src/**"]\n', PATH),
    ).toThrow(AgentConfigError);
  });

  it("rejects paths that would match nothing", () => {
    // Each of these retires the agent in silence otherwise.
    for (const paths of ["[]", '["!**/*.md"]', '["/packages/**"]', '["./src/**"]']) {
      expect(() =>
        parseAgentConfig(`${securityYaml}    paths: ${paths}\n`, PATH),
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
        return securityYaml;
      },
    });

    expect(paths).toEqual([DEFAULT_AGENT_CONFIG_PATH]);
  });

  it("reads the path it is given", async () => {
    const paths: string[] = [];

    await loadAgentDefinitions({
      readFile: async (path) => {
        paths.push(path);
        return securityYaml;
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

/** The whole point: a repository whose agent set is not this one's. */
describe("a repository naming a narrower set than this one", () => {
  it("carries that agent through selection, prompts, and synthesis", async () => {
    const agents = await loadAgentDefinitions({
      readFile: async () => "agents:\n  - docs-drift\n",
    });

    expect(agents.map((agent) => agent.category)).toEqual(["docs-drift"]);
    expect(Object.keys(inCodePrompts(agents)).map(agentPromptKey)).toEqual([
      "docs_drift_system",
    ]);
    expect(inCodePrompts(agents)["docs-drift"]).toContain(
      '"category": always "docs-drift"',
    );
    expect(buildSynthesisSystemPrompt(agents)).toContain(
      "1 review agent — Docs drift — has proposed",
    );
    expect(
      resolveAgentDefinitions("all", agents).map((agent) => agent.category),
    ).toEqual(["docs-drift"]);
    expect(() => resolveAgentDefinitions("security", agents)).toThrow(
      /Unknown review agent: security/,
    );
  });
});

/**
 * What this repository's own review actually asks for. The prose lives in the
 * specialists, so these assert the agents the configuration selects.
 */
describe("this repository's own configuration", () => {
  const focusOf = (category: string): string =>
    buildReviewSystemPrompt(repositoryAgent(category));

  it("parses, and names the agents the docs describe", () => {
    // The README points newcomers at this file as their starting point.
    expect(repositoryAgents().map((agent) => agent.category)).toEqual([
      "security",
      "correctness",
      "performance",
      "test-coverage",
      "docs-drift",
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

  it("aims the docs-drift agent at documentation this change made wrong", () => {
    const system = focusOf("docs-drift");

    for (const target of [
      /README/i,
      /command|flag|environment variable|file path/i,
      /comment/i,
      /example/i,
    ]) {
      expect(system).toMatch(target);
    }
    // Drift is invisible in the diff alone; the passage must be read first.
    expect(system).toMatch(
      /(get_file|search_repository).*(before|prior to).*report|before.*report.*(get_file|search_repository)/is,
    );
    expect(system).toMatch(/already stale/i);
  });
});
