/**
 * The composition root: input mapping, event loading, and the
 * entrypoint guard. Everything ambient is injected, so nothing here
 * reads the real environment, touches the filesystem, or builds an SDK
 * client — the only exception is the GITHUB_ACTIONS marker cleared
 * before import, because importing this module evaluates the guard and
 * CI itself sets that marker to "true".
 */
import { createCapturingLogger } from "@pr-review/logging";
import type { GithubInstallationClient } from "@pr-review/github";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalGithubActions = vi.hoisted(() => {
  const previous = process.env["GITHUB_ACTIONS"];
  delete process.env["GITHUB_ACTIONS"];
  return previous;
});

import {
  actionEnvironment,
  getInput,
  requireInput,
  runAction,
  runEntrypoint,
  type ActionEnvironment,
} from "./index.js";

afterAll(() => {
  if (originalGithubActions === undefined) {
    delete process.env["GITHUB_ACTIONS"];
  } else {
    process.env["GITHUB_ACTIONS"] = originalGithubActions;
  }
});

/** A structural stub of the read-only PR client; nothing may call it. */
function stubGithubClient(): GithubInstallationClient {
  const unexpected = (method: string) => () => {
    throw new Error(`unexpected GitHub call: ${method}`);
  };
  return {
    getPullRequest: vi.fn(unexpected("getPullRequest")),
    listChangedFiles: vi.fn(unexpected("listChangedFiles")),
    getDiff: vi.fn(unexpected("getDiff")),
    getFileContents: vi.fn(unexpected("getFileContents")),
    searchCode: vi.fn(unexpected("searchCode")),
    createCheckRun: vi.fn(unexpected("createCheckRun")),
  };
}

const validInputs = {
  "INPUT_ANTHROPIC-API-KEY": "sk-test-key",
  INPUT_MODEL: "claude-test-model",
  "INPUT_GITHUB-TOKEN": "ghs-test-token",
};

interface Harness {
  environment: ActionEnvironment;
  entries: ReturnType<typeof createCapturingLogger>["entries"];
  anthropicConfigs: { apiKey: string }[];
  tokenConfigs: { token: string }[];
  readPaths: string[];
  exitCodes: number[];
}

function harness(
  env: Record<string, string | undefined>,
  eventFile: string | Error = JSON.stringify({ action: "opened" }),
): Harness {
  const { logger, entries } = createCapturingLogger();
  const anthropicConfigs: { apiKey: string }[] = [];
  const tokenConfigs: { token: string }[] = [];
  const readPaths: string[] = [];
  const exitCodes: number[] = [];

  return {
    entries,
    anthropicConfigs,
    tokenConfigs,
    readPaths,
    exitCodes,
    environment: {
      env,
      readEventFile: (path) => {
        readPaths.push(path);
        return eventFile instanceof Error
          ? Promise.reject(eventFile)
          : Promise.resolve(eventFile);
      },
      createAnthropicClient: (config) => {
        anthropicConfigs.push({ apiKey: config.apiKey });
        return { messages: { create: vi.fn() } };
      },
      createTokenClient: (config) => {
        tokenConfigs.push({ token: config.token });
        return stubGithubClient();
      },
      logger,
      setExitCode: (code) => exitCodes.push(code),
    },
  };
}

/** Drains pending microtasks so the entrypoint's catch has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("getInput", () => {
  it("uppercases the input name and preserves dashes", () => {
    expect(getInput({ "INPUT_ANTHROPIC-API-KEY": "sk-1" }, "anthropic-api-key")).toBe(
      "sk-1",
    );
  });

  it("replaces spaces with underscores", () => {
    expect(getInput({ INPUT_MY_INPUT: "value" }, "my input")).toBe("value");
  });

  it("uppercases a name that is already uppercase or mixed case", () => {
    expect(getInput({ INPUT_MODEL: "m" }, "Model")).toBe("m");
    expect(getInput({ INPUT_MODEL: "m" }, "MODEL")).toBe("m");
  });

  it("trims surrounding whitespace from the value", () => {
    expect(getInput({ INPUT_MODEL: "  claude-test-model \n" }, "model")).toBe(
      "claude-test-model",
    );
  });

  it("returns the empty string when the variable is absent", () => {
    expect(getInput({}, "model")).toBe("");
  });

  it("returns the empty string for a whitespace-only value", () => {
    expect(getInput({ INPUT_MODEL: "   " }, "model")).toBe("");
  });

  it("does not fall back to an unprefixed environment variable", () => {
    expect(getInput({ MODEL: "leaked" }, "model")).toBe("");
  });
});

describe("requireInput", () => {
  it("returns the trimmed value when the input is present", () => {
    expect(requireInput({ INPUT_MODEL: " m " }, "model")).toBe("m");
  });

  it.each(["model", "anthropic-api-key", "github-token"])(
    "throws naming the %s input when it is missing",
    (name) => {
      expect(() => requireInput({}, name)).toThrow(
        `Missing required action input: ${name}`,
      );
    },
  );

  it("treats a whitespace-only input as missing", () => {
    expect(() => requireInput({ INPUT_MODEL: "  " }, "model")).toThrow(
      "Missing required action input: model",
    );
  });
});

describe("runAction", () => {
  it("fails when GITHUB_EVENT_PATH is not set", async () => {
    const { environment, readPaths } = harness({ ...validInputs });
    await expect(runAction(environment)).rejects.toThrow(
      "GITHUB_EVENT_PATH is not set",
    );
    expect(readPaths).toEqual([]);
  });

  it("fails when GITHUB_EVENT_PATH is set to the empty string", async () => {
    const { environment } = harness({ ...validInputs, GITHUB_EVENT_PATH: "" });
    await expect(runAction(environment)).rejects.toThrow(
      "GITHUB_EVENT_PATH is not set",
    );
  });

  it("propagates the error when the event file cannot be read", async () => {
    const { environment } = harness(
      { ...validInputs, GITHUB_EVENT_PATH: "/gone/event.json" },
      Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      }),
    );
    await expect(runAction(environment)).rejects.toThrow("ENOENT");
  });

  it("fails when the event file is not valid JSON", async () => {
    const { environment } = harness(
      { ...validInputs, GITHUB_EVENT_PATH: "/tmp/event.json" },
      "{ not json",
    );
    await expect(runAction(environment)).rejects.toThrow(SyntaxError);
  });

  it.each([
    ["anthropic-api-key", "INPUT_ANTHROPIC-API-KEY"],
    ["model", "INPUT_MODEL"],
    ["github-token", "INPUT_GITHUB-TOKEN"],
  ])("fails when the %s input is missing", async (name, variable) => {
    const env: Record<string, string | undefined> = {
      ...validInputs,
      GITHUB_EVENT_PATH: "/tmp/event.json",
    };
    delete env[variable];
    const { environment } = harness(env);
    await expect(runAction(environment)).rejects.toThrow(
      `Missing required action input: ${name}`,
    );
  });

  it("reads the event file and builds both clients from the inputs", async () => {
    const { environment, readPaths, anthropicConfigs, tokenConfigs, entries } =
      harness(
        {
          ...validInputs,
          GITHUB_EVENT_PATH: "/tmp/event.json",
          GITHUB_EVENT_NAME: "push",
        },
        JSON.stringify({ action: "opened" }),
      );

    await expect(runAction(environment)).resolves.toBeUndefined();

    expect(readPaths).toEqual(["/tmp/event.json"]);
    expect(anthropicConfigs).toEqual([{ apiKey: "sk-test-key" }]);
    expect(tokenConfigs).toEqual([{ token: "ghs-test-token" }]);
    // A non-pull_request event is a clean no-op, so no client is called.
    expect(entries).toEqual([
      { level: "info", event: "review.skipped", reason: "unsupported event: push" },
    ]);
  });

  it("treats an absent GITHUB_EVENT_NAME as an unsupported event", async () => {
    const { environment, entries } = harness({
      ...validInputs,
      GITHUB_EVENT_PATH: "/tmp/event.json",
    });

    await runAction(environment);

    expect(entries).toEqual([
      { level: "info", event: "review.skipped", reason: "unsupported event: " },
    ]);
  });
});

describe("runEntrypoint", () => {
  it.each([undefined, "", "false", "TRUE", "1"])(
    "performs no work when GITHUB_ACTIONS is %o",
    async (marker) => {
      const env: Record<string, string | undefined> = { ...validInputs };
      if (marker !== undefined) {
        env["GITHUB_ACTIONS"] = marker;
      }
      const { environment, entries, readPaths, exitCodes } = harness(env);

      runEntrypoint(environment);
      await flush();

      expect(readPaths).toEqual([]);
      expect(entries).toEqual([]);
      expect(exitCodes).toEqual([]);
    },
  );

  it("runs the action when GITHUB_ACTIONS is exactly \"true\"", async () => {
    const { environment, readPaths, entries, exitCodes } = harness({
      ...validInputs,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_PATH: "/tmp/event.json",
      GITHUB_EVENT_NAME: "push",
    });

    runEntrypoint(environment);
    await flush();

    expect(readPaths).toEqual(["/tmp/event.json"]);
    expect(entries.map((entry) => entry["event"])).toEqual(["review.skipped"]);
    expect(exitCodes).toEqual([]);
  });

  it("logs review.failed and sets a non-zero exit code when the run throws", async () => {
    const { environment, entries, exitCodes } = harness({
      ...validInputs,
      GITHUB_ACTIONS: "true",
    });

    runEntrypoint(environment);
    await flush();

    expect(exitCodes).toEqual([1]);
    expect(entries).toEqual([
      {
        level: "error",
        event: "review.failed",
        error: expect.stringContaining("GITHUB_EVENT_PATH is not set"),
        errorName: "Error",
      },
    ]);
  });

  it("stringifies a non-Error rejection in the review.failed log", async () => {
    const { environment, entries, exitCodes } = harness(
      { ...validInputs, GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: "/tmp/e.json" },
      // A rejection that is not an Error, e.g. a thrown string.
      "unused",
    );
    environment.readEventFile = () => Promise.reject("boom");

    runEntrypoint(environment);
    await flush();

    expect(exitCodes).toEqual([1]);
    expect(entries).toEqual([
      { level: "error", event: "review.failed", error: "boom", errorName: "Error" },
    ]);
  });

  it("does not run the action merely by importing the module", () => {
    // The import at the top of this file already evaluated the guard
    // with GITHUB_ACTIONS cleared; a run would have thrown on the
    // missing event path and set an exit code.
    expect(process.exitCode).not.toBe(1);
  });
});

describe("actionEnvironment", () => {
  it("wires the real process environment and client factories", () => {
    const environment = actionEnvironment();
    expect(environment.env).toBe(process.env);
    expect(typeof environment.readEventFile).toBe("function");
    expect(typeof environment.createAnthropicClient).toBe("function");
    expect(typeof environment.createTokenClient).toBe("function");
    expect(typeof environment.setExitCode).toBe("function");
    expect(typeof environment.logger.info).toBe("function");
    expect(typeof environment.logger.error).toBe("function");
  });
});
