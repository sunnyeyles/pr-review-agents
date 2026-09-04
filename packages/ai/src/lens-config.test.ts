/**
 * Lens configuration. There is no built-in lens set, so this is the only
 * place a run's agents can come from — and every way it can go wrong has
 * to fail loudly rather than review with fewer agents than intended.
 */
import { describe, expect, it } from "vitest";

import { repositoryLens, repositoryLenses } from "./agent-test-support.js";
import { resolveReviewLenses } from "./agents/lens-set.js";
import { buildSynthesisSystemPrompt } from "./agents/synthesiser.js";
import {
  DEFAULT_LENS_CONFIG_PATH,
  LensConfigError,
  loadLensSet,
  parseLensConfig,
} from "./lens-config.js";
import { buildReviewSystemPrompt, lensPromptKey } from "./agents/lens.js";
import { inCodePrompts } from "./prompts.js";

const PATH = "config.yml";

const performanceYaml = `
lenses:
  - category: performance
    role: Performance reviewer
    focus: |
      Review ONLY for performance problems.
`;

/** The categories a config document defines, in order. */
function categories(source: string): string[] {
  return parseLensConfig(source, PATH).map((lens) => lens.category);
}

describe("parseLensConfig", () => {
  it("returns the lenses in the order they are written", () => {
    expect(
      categories(`${performanceYaml}  - category: security
    role: Security reviewer
    focus: Review ONLY for security problems.
`),
    ).toEqual(["performance", "security"]);
  });

  it("keeps an optional contextGuidance and omits it otherwise", () => {
    const [plain] = parseLensConfig(performanceYaml, PATH);
    expect(plain?.contextGuidance).toBeUndefined();

    const [guided] = parseLensConfig(
      `${performanceYaml}    contextGuidance: Read the neighbours first.\n`,
      PATH,
    );
    expect(guided?.contextGuidance).toBe("Read the neighbours first.");
  });

  it("rejects an empty document, which would define no agents", () => {
    for (const source of ["", "# just a comment\n", "lenses: []\n"]) {
      expect(() => parseLensConfig(source, PATH)).toThrow(LensConfigError);
    }
  });

  it("rejects YAML that does not parse, naming the file", () => {
    expect(() => parseLensConfig("lenses: [\n", PATH)).toThrow(/config\.yml/);
  });

  it("rejects a lens missing its role or focus", () => {
    expect(() =>
      parseLensConfig("lenses:\n  - category: performance\n", PATH),
    ).toThrow(/role/);
  });

  it("rejects a category that is not a lowercase slug", () => {
    for (const bad of ["Performance", "perf ormance", "9lives"]) {
      expect(() =>
        parseLensConfig(performanceYaml.replace("performance", bad), PATH),
      ).toThrow(LensConfigError);
    }
  });

  it("rejects the reserved synthesis and all names", () => {
    for (const reserved of ["synthesis", "all"]) {
      expect(() =>
        parseLensConfig(performanceYaml.replace("performance", reserved), PATH),
      ).toThrow(/reserved/);
    }
  });

  it("rejects the same agent defined twice", () => {
    // One of the two would silently win, and prompt keys would collide.
    expect(() =>
      parseLensConfig(`${performanceYaml}${performanceYaml.replace("lenses:\n", "")}`, PATH),
    ).toThrow(/twice/);
  });

  it("rejects an unknown top-level key rather than ignoring it", () => {
    // A typo'd key would silently review with the wrong agents.
    expect(() =>
      parseLensConfig("lense:\n  - category: performance\n", PATH),
    ).toThrow(LensConfigError);
  });

  it("rejects an unknown key within a lens", () => {
    // contextGuidance is optional, so a misspelling would drop the
    // agent's evidence requirement without a word.
    for (const typo of ["contextguidance", "context_guidance", "guidance"]) {
      expect(() =>
        parseLensConfig(`${performanceYaml}    ${typo}: Read the neighbours first.\n`, PATH),
      ).toThrow(LensConfigError);
    }
  });
});

describe("loadLensSet", () => {
  it("reads the default path", async () => {
    const paths: string[] = [];

    await loadLensSet({
      readFile: async (path) => {
        paths.push(path);
        return performanceYaml;
      },
    });

    expect(paths).toEqual([DEFAULT_LENS_CONFIG_PATH]);
  });

  it("reads the path it is given", async () => {
    const paths: string[] = [];

    await loadLensSet({
      readFile: async (path) => {
        paths.push(path);
        return performanceYaml;
      },
      path: "config/lenses.yml",
    });

    expect(paths).toEqual(["config/lenses.yml"]);
  });

  it("fails with an actionable message when no config exists", async () => {
    // Nothing ships by default, so this must never quietly review nothing.
    await expect(loadLensSet({ readFile: async () => undefined })).rejects.toThrow(
      /No review agents are configured/,
    );
    await expect(loadLensSet({ readFile: async () => undefined })).rejects.toThrow(
      /lenses:/,
    );
  });

  it("throws rather than reviewing with the wrong agents", async () => {
    await expect(
      loadLensSet({ readFile: async () => "lenses: not-a-list\n" }),
    ).rejects.toThrow(LensConfigError);
  });
});

/** The whole point: a repository whose agents share nothing with this one. */
describe("a repository configuring one agent of its own", () => {
  const onlyPerformance = `
lenses:
  - category: performance
    role: Performance reviewer
    focus: |
      Review ONLY for performance problems. Do NOT report style.
`;

  it("carries that agent through selection, prompts, and synthesis", async () => {
    const lenses = await loadLensSet({ readFile: async () => onlyPerformance });

    expect(lenses.map((lens) => lens.category)).toEqual(["performance"]);
    expect(Object.keys(inCodePrompts(lenses)).map(lensPromptKey)).toEqual([
      "performance_system",
      "synthesis_system",
    ]);
    expect(inCodePrompts(lenses)["performance"]).toContain(
      '"category": always "performance"',
    );
    expect(buildSynthesisSystemPrompt(lenses)).toContain(
      "1 review agent — Performance — has proposed",
    );
    expect(
      resolveReviewLenses("all", lenses).map((lens) => lens.category),
    ).toEqual(["performance"]);
    expect(() => resolveReviewLenses("security", lenses)).toThrow(
      /Unknown review agent: security/,
    );
  });
});

/**
 * The prose in .github/pr-review.yml is configuration, so what it must
 * say belongs here rather than in the engine's own tests.
 */
describe("this repository's own configuration", () => {
  const focusOf = (category: string): string =>
    buildReviewSystemPrompt(repositoryLens(category));

  it("parses, and defines the agents the docs describe", () => {
    // The README points newcomers at this file as their starting point.
    expect(repositoryLenses().map((lens) => lens.category)).toEqual([
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
