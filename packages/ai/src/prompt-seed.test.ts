/** The seeding decision logic against a stub writer; no Langfuse project involved. */
import { createCapturingLogger } from "@pr-review/logging";
import { describe, expect, it, vi } from "vitest";

import {
  repositoryLenses,
  validRemotePrompt,
  validRemoteSynthesisPrompt,
} from "./agent-test-support.js";
import {
  seedFailed,
  seedManagedPrompts,
  type LabelledPrompt,
  type LangfusePromptWriter,
} from "./prompt-seed.js";
import { managedPromptKeys } from "./prompts.js";

const configuredLenses = repositoryLenses();

/** One prompt per configured lens, all satisfying the contract guard. */
function validPrompts() {
  return {
    correctness: validRemotePrompt("correctness", "SEED CORRECTNESS"),
    security: validRemotePrompt("security", "SEED SECURITY"),
    architecture: validRemotePrompt("architecture", "SEED ARCHITECTURE"),
    synthesis: validRemoteSynthesisPrompt("SEED SYNTHESIS"),
  };
}

interface StubWriter {
  writer: LangfusePromptWriter;
  published: { name: string; text: string; label: string }[];
}

/**
 * Builds the write seam from a name → current-state table: a
 * LabelledPrompt is held, `undefined` is absent, an Error rejects the read.
 */
function makeWriter(
  existing: Record<string, LabelledPrompt | Error | undefined> = {},
): StubWriter {
  const published: { name: string; text: string; label: string }[] = [];
  return {
    published,
    writer: {
      readLabelled: vi.fn(async (name: string) => {
        const current = existing[name];
        if (current instanceof Error) {
          throw current;
        }
        return current;
      }),
      publish: vi.fn(async ({ name, text, label }) => {
        published.push({ name, text, label });
        return { text, version: 7 };
      }),
    },
  };
}

describe("seedManagedPrompts", () => {
  it("creates every prompt in an empty project", async () => {
    const { writer, published } = makeWriter();

    const report = await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts: validPrompts(),
      logger: createCapturingLogger().logger,
    });

    expect(report).toEqual({
      correctness: "created",
      security: "created",
      architecture: "created",
      synthesis: "created",
    });
    expect(published.map((entry) => entry.name).sort()).toEqual([
      "architecture_system",
      "correctness_system",
      "security_system",
      "synthesis_system",
    ]);
    expect(seedFailed(report)).toBe(false);
  });

  it("writes nothing when every prompt already matches", async () => {
    const prompts = validPrompts();
    const { writer, published } = makeWriter({
      correctness_system: { text: prompts.correctness, version: 1 },
      security_system: { text: prompts.security, version: 1 },
      architecture_system: { text: prompts.architecture, version: 1 },
      synthesis_system: { text: prompts.synthesis, version: 1 },
    });

    const report = await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts,
      logger: createCapturingLogger().logger,
    });

    expect(report).toEqual({
      correctness: "unchanged",
      security: "unchanged",
      architecture: "unchanged",
      synthesis: "unchanged",
    });
    // Re-running must not pile permanent versions onto a current project.
    expect(published).toEqual([]);
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it("ignores surrounding whitespace when comparing", async () => {
    const prompts = validPrompts();
    const { writer, published } = makeWriter({
      correctness_system: { text: `\n${prompts.correctness}\n  `, version: 3 },
      security_system: { text: prompts.security, version: 1 },
      architecture_system: { text: prompts.architecture, version: 1 },
      synthesis_system: { text: prompts.synthesis, version: 1 },
    });

    const report = await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts,
      logger: createCapturingLogger().logger,
    });

    expect(report.correctness).toBe("unchanged");
    expect(published).toEqual([]);
  });

  it("publishes a new version when the stored text differs", async () => {
    const prompts = validPrompts();
    const { writer, published } = makeWriter({
      correctness_system: {
        text: validRemotePrompt("correctness", "EDITED IN THE UI"),
        version: 4,
      },
      security_system: { text: prompts.security, version: 1 },
      architecture_system: { text: prompts.architecture, version: 1 },
      synthesis_system: { text: prompts.synthesis, version: 1 },
    });

    const report = await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts,
      logger: createCapturingLogger().logger,
    });

    expect(report.correctness).toBe("updated");
    expect(report.security).toBe("unchanged");
    expect(published).toEqual([
      {
        name: "correctness_system",
        text: prompts.correctness,
        label: "production",
      },
    ]);
  });

  it("refuses to publish a prompt the runtime guard would reject", async () => {
    const prompts = validPrompts();
    // Loses its category stamp, so its findings would be discarded downstream.
    prompts.correctness = validRemotePrompt("security", "WRONG CATEGORY");
    const { writer, published } = makeWriter();
    const { logger, entries } = createCapturingLogger();

    const report = await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts,
      logger,
    });

    expect(report.correctness).toBe("rejected");
    expect(published.map((entry) => entry.name)).not.toContain(
      "correctness_system",
    );
    // The other three are unaffected.
    expect(report.security).toBe("created");
    expect(seedFailed(report)).toBe(true);
    const rejection = entries.find(
      (entry) => entry.event === "langfuse.prompts.seed_rejected",
    );
    expect(rejection?.["reason"]).toContain("missing-category-contract");
  });

  it("reports one prompt's failure without losing the others", async () => {
    const { writer, published } = makeWriter({
      correctness_system: new Error("langfuse unavailable"),
    });

    const report = await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts: validPrompts(),
      logger: createCapturingLogger().logger,
    });

    expect(report.correctness).toBe("failed");
    expect(report.security).toBe("created");
    expect(report.architecture).toBe("created");
    expect(report.synthesis).toBe("created");
    expect(published).toHaveLength(3);
    expect(seedFailed(report)).toBe(true);
  });

  it("decides everything and writes nothing on a dry run", async () => {
    const prompts = validPrompts();
    const { writer, published } = makeWriter({
      correctness_system: {
        text: validRemotePrompt("correctness", "EDITED IN THE UI"),
        version: 4,
      },
      security_system: { text: prompts.security, version: 1 },
    });

    const report = await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts,
      dryRun: true,
      logger: createCapturingLogger().logger,
    });

    expect(report).toEqual({
      correctness: "updated",
      security: "unchanged",
      architecture: "created",
      synthesis: "created",
    });
    expect(published).toEqual([]);
  });

  it("targets the label it was given, on both the read and the write", async () => {
    const { writer, published } = makeWriter();

    await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts: validPrompts(),
      label: "staging",
      logger: createCapturingLogger().logger,
    });

    for (const name of Object.values(managedPromptKeys(configuredLenses))) {
      expect(writer.readLabelled).toHaveBeenCalledWith(name, "staging");
    }
    expect(published.every((entry) => entry.label === "staging")).toBe(true);
  });

  it("defaults to the production label", async () => {
    const { writer } = makeWriter();

    await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts: validPrompts(),
      logger: createCapturingLogger().logger,
    });

    expect(writer.readLabelled).toHaveBeenCalledWith(
      "correctness_system",
      "production",
    );
  });

  it("never logs a prompt body", async () => {
    const { writer } = makeWriter();
    const { logger, entries } = createCapturingLogger();
    const prompts = validPrompts();

    await seedManagedPrompts(writer, {
      lenses: configuredLenses,
      prompts,
      logger,
    });

    // A log line carrying a whole prompt makes every review log unreadable.
    const serialised = JSON.stringify(entries);
    for (const prompt of Object.values(prompts)) {
      expect(serialised).not.toContain(prompt);
    }
  });
});
