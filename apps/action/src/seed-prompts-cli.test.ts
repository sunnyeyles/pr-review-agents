/**
 * The seeding command's wiring: argument parsing, credential handling,
 * exit codes, and that the text handed to Langfuse is byte-for-byte
 * what a review would have fallen back to.
 */

import {
  buildSynthesisSystemPrompt,
  inCodePrompts,
  type LangfusePromptWriter,
} from "@pr-review/ai";
import {
  repositoryAgentConfigYaml,
  repositoryAgents,
} from "../../../packages/ai/src/agent-test-support.js";
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it, vi } from "vitest";

import {
  MISSING_CREDENTIALS_MESSAGE,
  USAGE_EXIT_CODE,
  main,
  parseSeedArgs,
  requireLangfuseConfig,
} from "./seed-prompts-cli.js";

const CREDENTIALS = {
  LANGFUSE_PUBLIC_KEY: "pk-test",
  LANGFUSE_SECRET_KEY: "sk-test",
};

const configuredAgents = repositoryAgents();
const SYNTHESIS_SYSTEM_PROMPT = buildSynthesisSystemPrompt(configuredAgents);
/** The seeder reads the same config the action does. */
const configYaml = repositoryAgentConfigYaml();

interface Harness {
  environment: Parameters<typeof main>[1] & {};
  published: { name: string; text: string; label: string }[];
  lines: string[];
}

/** A CLI environment whose Langfuse project is empty and offline. */
function harness(
  env: Record<string, string | undefined> = CREDENTIALS,
  writerOverrides: Partial<LangfusePromptWriter> = {},
): Harness {
  const published: { name: string; text: string; label: string }[] = [];
  const lines: string[] = [];
  return {
    published,
    lines,
    environment: {
      env,
      readConfigFile: async () => configYaml,
      createWriter: vi.fn(() => ({
        readLabelled: vi.fn(async () => undefined),
        publish: vi.fn(async ({ name, text, label }) => {
          published.push({ name, text, label });
          return { text, version: 1 };
        }),
        ...writerOverrides,
      })),
      logger: createCapturingLogger().logger,
      write: (line: string) => lines.push(line),
    },
  };
}

describe("parseSeedArgs", () => {
  it("defaults to the production label, a real run, and the default config", () => {
    expect(parseSeedArgs([])).toEqual({
      label: "production",
      dryRun: false,
      config: ".github/pr-review-agents.yml",
    });
  });

  it("accepts --label in both spellings", () => {
    expect(parseSeedArgs(["--label", "staging"]).label).toBe("staging");
    expect(parseSeedArgs(["--label=staging"]).label).toBe("staging");
  });

  it("accepts --config in both spellings", () => {
    expect(parseSeedArgs(["--config", "agents.yml"]).config).toBe("agents.yml");
    expect(parseSeedArgs(["--config=agents.yml"]).config).toBe("agents.yml");
  });

  it("accepts --dry-run alongside a label", () => {
    expect(parseSeedArgs(["--label", "staging", "--dry-run"])).toEqual({
      label: "staging",
      dryRun: true,
      config: ".github/pr-review-agents.yml",
    });
  });

  it("ignores the separator pnpm forwards", () => {
    // pnpm leaves the `--` separator attached when it reaches the CLI.
    expect(parseSeedArgs(["--", "--dry-run"])).toEqual({
      label: "production",
      dryRun: true,
      config: ".github/pr-review-agents.yml",
    });
  });

  it("rejects a flag with no value", () => {
    expect(() => parseSeedArgs(["--label"])).toThrow(/--label needs a value/);
    expect(() => parseSeedArgs(["--label", "--dry-run"])).toThrow(
      /--label needs a value/,
    );
    expect(() => parseSeedArgs(["--config"])).toThrow(/--config needs a value/);
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    // A mistyped --dry-run must never fall through to a real publish.
    expect(() => parseSeedArgs(["--dryrun"])).toThrow(/Unknown argument/);
  });
});

describe("requireLangfuseConfig", () => {
  it("defaults the host but never the keys", () => {
    expect(requireLangfuseConfig(CREDENTIALS)).toEqual({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://cloud.langfuse.com",
    });
  });

  it("honours a self-hosted or regional host", () => {
    expect(
      requireLangfuseConfig({
        ...CREDENTIALS,
        LANGFUSE_BASE_URL: "https://jp.cloud.langfuse.com",
      }).baseUrl,
    ).toBe("https://jp.cloud.langfuse.com");
  });

  it("throws when either key is missing", () => {
    expect(() => requireLangfuseConfig({})).toThrow(MISSING_CREDENTIALS_MESSAGE);
    expect(() =>
      requireLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk-test" }),
    ).toThrow(MISSING_CREDENTIALS_MESSAGE);
  });
});

describe("main", () => {
  it("publishes all four prompts and succeeds", async () => {
    const { environment, published, lines } = harness();

    await expect(main([], environment)).resolves.toBe(0);

    expect(published.map((entry) => entry.name).sort()).toEqual([
      "architecture_system",
      "correctness_system",
      "security_system",
      "synthesis_system",
    ]);
    expect(lines.join("\n")).toContain("correctness");
  });

  it("publishes exactly the prompts a review would fall back to", async () => {
    const { environment, published } = harness();

    await main([], environment);

    const expected = inCodePrompts(configuredAgents);
    const byName = new Map(published.map((e) => [e.name, e.text]));
    expect(byName.get("correctness_system")).toBe(expected.correctness);
    expect(byName.get("security_system")).toBe(expected.security);
    expect(byName.get("architecture_system")).toBe(expected.architecture);
    expect(byName.get("synthesis_system")).toBe(SYNTHESIS_SYSTEM_PROMPT);
  });

  it("threads the label through to the publish", async () => {
    const { environment, published } = harness();

    await main(["--label", "staging"], environment);

    expect(published.every((entry) => entry.label === "staging")).toBe(true);
  });

  it("writes nothing on a dry run and still succeeds", async () => {
    const { environment, published, lines } = harness();

    await expect(main(["--dry-run"], environment)).resolves.toBe(0);

    expect(published).toEqual([]);
    expect(lines[0]).toContain("dry run");
    expect(lines.join("\n")).toContain("would be created");
  });

  it("reports missing credentials without building a client", async () => {
    const { environment, lines } = harness({});

    await expect(main([], environment)).resolves.toBe(USAGE_EXIT_CODE);

    expect(lines.join("\n")).toBe(MISSING_CREDENTIALS_MESSAGE);
    expect(environment.createWriter).not.toHaveBeenCalled();
  });

  it("reports a bad argument without building a client", async () => {
    const { environment, lines } = harness();

    await expect(main(["--nope"], environment)).resolves.toBe(USAGE_EXIT_CODE);

    expect(lines.join("\n")).toContain("Unknown argument: --nope");
    expect(environment.createWriter).not.toHaveBeenCalled();
  });

  it("exits non-zero when a prompt could not be published", async () => {
    const { environment } = harness(CREDENTIALS, {
      readLabelled: vi.fn(async (name: string) => {
        if (name === "security_system") {
          throw new Error("langfuse unavailable");
        }
        return undefined;
      }),
    });

    await expect(main([], environment)).resolves.toBe(1);
  });
});
