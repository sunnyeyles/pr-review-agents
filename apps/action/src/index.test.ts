/**
 * The composition root: input mapping, event loading, and the entrypoint
 * guard. GITHUB_ACTIONS is cleared before import because importing the
 * module under test evaluates the guard.
 */
import {
  baseSha,
  finalFindingsJson,
  headSha,
  makeGithub,
  message,
  repositoryAgentConfigYaml,
  textBlock,
  validRemotePrompt,
  validRemoteSynthesisPrompt,
} from "../../../packages/ai/src/agent-test-support.js";
import { createCapturingLogger } from "@pr-review/logging";
import type { FileContentsRequest, GithubInstallationClient } from "@pr-review/github";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalGithubActions = vi.hoisted(() => {
  const previous = process.env["GITHUB_ACTIONS"];
  delete process.env["GITHUB_ACTIONS"];
  return previous;
});

import {
  actionEnvironment,
  getInput,
  readAtCommit,
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

const validInputs = {
  "INPUT_API-KEY": "sk-test-key",
  INPUT_MODEL: "claude-test-model",
  "INPUT_GITHUB-TOKEN": "ghs-test-token",
};

/** The agent configuration the repository has committed on its base branch. */
const agentConfigYaml = repositoryAgentConfigYaml();

/** An HTTP failure shaped the way Octokit raises one. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** A pull_request event the action will actually review. */
function pullRequestEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    repository: { name: "example-service", owner: { login: "octo-org" } },
    pull_request: {
      number: 42,
      base: { sha: baseSha },
      head: { sha: headSha, repo: { full_name: "octo-org/example-service" } },
    },
    ...overrides,
  });
}

interface Harness {
  environment: ActionEnvironment;
  entries: ReturnType<typeof createCapturingLogger>["entries"];
  modelConfigs: { provider: string; apiKey: string; baseUrl?: string | undefined }[];
  tokenConfigs: { token: string }[];
  promptClientConfigs: { publicKey: string; secretKey: string; baseUrl: string }[];
  /** Prompt names fetched, in order, across every client built. */
  promptFetches: { name: string; label: string | undefined }[];
  tracingConfigs: { baseUrl: string; release?: string | undefined }[];
  /** How many times spans were flushed across the run. */
  flushCount: () => number;
  readPaths: string[];
  /** Every repository file read, with the commit it was read at. */
  fileReads: { path: string; ref: string }[];
  /** How many times a review agent called the model. */
  modelCalls: () => number;
  exitCodes: number[];
}

interface HarnessOptions {
  /** Absent means the Langfuse seams are wired but must never be reached. */
  prompts?: Record<string, string | Error> | undefined;
  /** Replaces the agent configuration the base commit serves. */
  config?: string | Error | undefined;
  /** Fails every model call, after tracing has already started. */
  modelError?: Error | undefined;
}

function harness(
  env: Record<string, string | undefined>,
  eventFile: string | Error = pullRequestEvent(),
  options: HarnessOptions = {},
): Harness {
  const { logger, entries } = createCapturingLogger();
  const modelConfigs: Harness["modelConfigs"] = [];
  const tokenConfigs: { token: string }[] = [];
  const promptClientConfigs: Harness["promptClientConfigs"] = [];
  const promptFetches: Harness["promptFetches"] = [];
  const tracingConfigs: Harness["tracingConfigs"] = [];
  let flushCount = 0;
  let modelCalls = 0;
  const readPaths: string[] = [];
  const fileReads: Harness["fileReads"] = [];
  const exitCodes: number[] = [];

  const configured = options.config ?? agentConfigYaml;
  const client: GithubInstallationClient = {
    ...makeGithub(),
    getFileContents: vi.fn(async (request: FileContentsRequest) => {
      fileReads.push({ path: request.path, ref: request.ref });
      if (configured instanceof Error) {
        throw configured;
      }
      return configured;
    }),
  };

  return {
    entries,
    modelConfigs,
    tokenConfigs,
    promptClientConfigs,
    promptFetches,
    tracingConfigs,
    flushCount: () => flushCount,
    readPaths,
    fileReads,
    modelCalls: () => modelCalls,
    exitCodes,
    environment: {
      env,
      readEventFile: (path) => {
        readPaths.push(path);
        return eventFile instanceof Error
          ? Promise.reject(eventFile)
          : Promise.resolve(eventFile);
      },
      createModelClient: (config) => {
        modelConfigs.push({
          provider: config.provider,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
        });
        return {
          provider: config.provider,
          createMessage: vi.fn(async () => {
            modelCalls += 1;
            if (options.modelError !== undefined) {
              throw options.modelError;
            }
            // No findings, so the synthesiser is never reached.
            return message([textBlock(finalFindingsJson([]))], "end_turn");
          }),
        };
      },
      createTokenClient: (config) => {
        tokenConfigs.push({ token: config.token });
        return client;
      },
      createPromptClient: (config) => {
        promptClientConfigs.push({
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          baseUrl: config.baseUrl,
        });
        return {
          getTextPrompt: (name, fetchOptions) => {
            promptFetches.push({ name, label: fetchOptions?.label });
            const scripted = options.prompts?.[name];
            if (scripted === undefined) {
              return Promise.reject(new Error(`unexpected prompt fetch: ${name}`));
            }
            return scripted instanceof Error
              ? Promise.reject(scripted)
              : Promise.resolve(scripted);
          },
        };
      },
      createLangfuseRuntime: (config) => {
        tracingConfigs.push({
          baseUrl: config.baseUrl,
          release: config.release,
        });
        return {
          forceFlush: () => {
            flushCount += 1;
            return Promise.resolve();
          },
        };
      },
      logger,
      setExitCode: (code) => exitCodes.push(code),
    },
  };
}

/** The events one run logged, in order. */
function events(entries: Record<string, unknown>[]): unknown[] {
  return entries.map((entry) => entry["event"]);
}

/** Drains pending microtasks so the entrypoint's catch has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const reviewEnv = {
  ...validInputs,
  GITHUB_EVENT_PATH: "/tmp/event.json",
  GITHUB_EVENT_NAME: "pull_request",
};

describe("getInput", () => {
  it("uppercases the input name and preserves dashes", () => {
    expect(getInput({ "INPUT_MODEL-BASE-URL": "u" }, "model-base-url")).toBe("u");
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

  it.each(["model", "github-token"])(
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

describe("readAtCommit", () => {
  const repository = { owner: "octo-org", repo: "example-service" };

  it("reads the requested path at the given commit", async () => {
    const client = { ...makeGithub(), getFileContents: vi.fn(async () => "agents:\n") };
    const read = readAtCommit(client, repository, baseSha);

    await expect(read(".github/pr-review-agents.yml")).resolves.toBe("agents:\n");
    expect(client.getFileContents).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "example-service",
      path: ".github/pr-review-agents.yml",
      ref: baseSha,
    });
  });

  it("resolves undefined for a file the commit does not have", async () => {
    const client = {
      ...makeGithub(),
      getFileContents: vi.fn(() => Promise.reject(httpError(404))),
    };

    await expect(
      readAtCommit(client, repository, baseSha)(".github/pr-review-agents.yml"),
    ).resolves.toBeUndefined();
  });

  it.each([403, 500])(
    "propagates a %s rather than reporting the file as absent",
    async (status) => {
      // A token without contents:read must not read as "no agents configured".
      const client = {
        ...makeGithub(),
        getFileContents: vi.fn(() => Promise.reject(httpError(status))),
      };

      await expect(
        readAtCommit(client, repository, baseSha)(".github/pr-review-agents.yml"),
      ).rejects.toThrow(`HTTP ${status}`);
    },
  );
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

  it("fails when the github-token input is missing", async () => {
    const env: Record<string, string | undefined> = { ...reviewEnv };
    delete env["INPUT_GITHUB-TOKEN"];
    const { environment } = harness(env);
    await expect(runAction(environment)).rejects.toThrow(
      "Missing required action input: github-token",
    );
  });

  it("fails when neither the API key input nor the provider's variable is set", async () => {
    const env: Record<string, string | undefined> = { ...reviewEnv };
    delete env["INPUT_API-KEY"];
    const { environment } = harness(env);
    await expect(runAction(environment)).rejects.toThrow(
      "Missing required action input: api-key (or the ANTHROPIC_API_KEY environment variable)",
    );
  });

  it("falls back to the selected provider's own key variable", async () => {
    const env: Record<string, string | undefined> = { ...reviewEnv };
    delete env["INPUT_API-KEY"];
    const { environment, modelConfigs } = harness({
      ...env,
      "INPUT_MODEL-PROVIDER": "openai",
      ANTHROPIC_API_KEY: "sk-anthropic-key",
      OPENAI_API_KEY: "sk-openai-key",
    });

    await expect(runAction(environment)).resolves.toBeUndefined();

    expect(modelConfigs[0]).toMatchObject({
      provider: "openai",
      apiKey: "sk-openai-key",
    });
  });

  it("defaults the model id when the model input is empty", async () => {
    const env: Record<string, string | undefined> = { ...reviewEnv };
    delete env["INPUT_MODEL"];
    const { environment, entries } = harness(env);

    await expect(runAction(environment)).resolves.toBeUndefined();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "review.model_selected",
        provider: "anthropic",
        model: "claude-sonnet-5",
      }),
    );
  });

  it("builds the client for the selected provider and base URL", async () => {
    const { environment, modelConfigs } = harness({
      ...reviewEnv,
      "INPUT_MODEL-PROVIDER": "openai",
      "INPUT_API-KEY": "sk-openai-key",
      "INPUT_MODEL-BASE-URL": "https://gateway.example/v1",
      INPUT_MODEL: "gpt-test-model",
    });

    await expect(runAction(environment)).resolves.toBeUndefined();

    expect(modelConfigs).toEqual([
      {
        provider: "openai",
        apiKey: "sk-openai-key",
        baseUrl: "https://gateway.example/v1",
      },
    ]);
  });

  it("fails on an unknown provider before building any client", async () => {
    const { environment, modelConfigs } = harness({
      ...reviewEnv,
      "INPUT_MODEL-PROVIDER": "wattson",
    });

    await expect(runAction(environment)).rejects.toThrow(
      /Unknown model provider: wattson/,
    );
    expect(modelConfigs).toEqual([]);
  });

  it("reads the event file, builds both clients, and reviews", async () => {
    const { environment, readPaths, modelConfigs, tokenConfigs, entries } =
      harness(reviewEnv);

    await expect(runAction(environment)).resolves.toBeUndefined();

    expect(readPaths).toEqual(["/tmp/event.json"]);
    expect(modelConfigs).toEqual([
      { provider: "anthropic", apiKey: "sk-test-key", baseUrl: undefined },
    ]);
    expect(tokenConfigs).toEqual([{ token: "ghs-test-token" }]);
    expect(events(entries)).toContain("review.started");
  });

  it.each([
    ["push", "unsupported event: push"],
    ["", "unsupported event: "],
  ])("skips %o without reading configuration", async (eventName, reason) => {
    // An event nobody reviews must not fail on a repository that has no
    // agents configured, and has no base commit to read them from.
    const env: Record<string, string | undefined> = { ...reviewEnv };
    if (eventName === "") {
      delete env["GITHUB_EVENT_NAME"];
    } else {
      env["GITHUB_EVENT_NAME"] = eventName;
    }
    const { environment, entries, fileReads, tokenConfigs } = harness(env);

    await expect(runAction(environment)).resolves.toBeUndefined();

    expect(entries).toEqual([
      { level: "info", event: "review.skipped", reason },
    ]);
    expect(fileReads).toEqual([]);
    expect(tokenConfigs).toEqual([]);
  });

  it("skips an ignored action without reading configuration", async () => {
    const { environment, entries, fileReads } = harness(
      reviewEnv,
      pullRequestEvent({ action: "labeled" }),
    );

    await runAction(environment);

    expect(entries).toEqual([
      { level: "info", event: "review.skipped", reason: "action ignored: labeled" },
    ]);
    expect(fileReads).toEqual([]);
  });
});

/**
 * Where the agent configuration comes from. It becomes the agents' system
 * prompts, so reading it from the pull request's own head or merge ref
 * would let the branch under review rewrite its reviewers.
 */
describe("agent configuration", () => {
  it("reads it from the pull request's base commit", async () => {
    const { environment, fileReads } = harness(reviewEnv);

    await runAction(environment);

    expect(fileReads).toEqual([{ path: ".github/pr-review-agents.yml", ref: baseSha }]);
    expect(fileReads.every((read) => read.ref !== headSha)).toBe(true);
  });

  it("honours the agent-config input", async () => {
    const { environment, fileReads } = harness({
      ...reviewEnv,
      "INPUT_AGENT-CONFIG": "ci/agents.yml",
    });

    await runAction(environment);

    expect(fileReads).toEqual([{ path: "ci/agents.yml", ref: baseSha }]);
  });

  it("fails the step when the base commit has no configuration", async () => {
    const { environment, modelConfigs } = harness(reviewEnv, pullRequestEvent(), {
      config: httpError(404),
    });

    await expect(runAction(environment)).rejects.toThrow(
      /No review agents are configured/,
    );
    expect(modelConfigs).toEqual([]);
  });

  it("fails the step when the configuration is malformed", async () => {
    const { environment } = harness(reviewEnv, pullRequestEvent(), {
      config: "agents: []\n",
    });

    await expect(runAction(environment)).rejects.toThrow(/is invalid/);
  });
});

/**
 * Selecting which agents run. Selection itself is pinned in
 * @pr-review/ai's agents.test.ts; what belongs here is the wiring —
 * that the input reaches the parser, that the run always records which
 * agents it chose, and that a bad value costs nothing.
 */
describe("agent selection", () => {
  /** The `review.agents_selected` entry, which every reviewed run emits. */
  const selection = (entries: Record<string, unknown>[]) =>
    entries.find((entry) => entry["event"] === "review.agents_selected");

  it("records the configured set when the default runs", async () => {
    const { environment, entries } = harness(reviewEnv);

    await runAction(environment);

    expect(selection(entries)).toEqual({
      level: "info",
      event: "review.agents_selected",
      agents: ["correctness", "security", "architecture"],
      configuredAgents: ["correctness", "security", "architecture"],
    });
  });

  it("reports the narrowed set, in spec order", async () => {
    const { environment, entries, modelCalls } = harness({
      ...reviewEnv,
      INPUT_AGENTS: "architecture,correctness",
    });

    await runAction(environment);

    expect(selection(entries)).toEqual({
      level: "info",
      event: "review.agents_selected",
      agents: ["correctness", "architecture"],
      configuredAgents: ["correctness", "security", "architecture"],
    });
    expect(modelCalls()).toBe(2);
  });

  it("treats an explicit `all` as the default", async () => {
    const { environment, entries } = harness({
      ...reviewEnv,
      INPUT_AGENTS: "all",
    });

    await runAction(environment);

    expect(selection(entries)?.["agents"]).toEqual([
      "correctness",
      "security",
      "architecture",
    ]);
  });

  it("fails on an unknown name before building the model client", async () => {
    // The whole point of resolving the input first: a typo in the
    // workflow file must not cost a model call.
    const { environment, modelConfigs, modelCalls } = harness({
      ...reviewEnv,
      INPUT_AGENTS: "secuirty",
    });

    await expect(runAction(environment)).rejects.toThrow(
      /Unknown review agent: secuirty/,
    );
    expect(modelConfigs).toEqual([]);
    expect(modelCalls()).toBe(0);
  });
});

const remotePrompts = {
  correctness_system: validRemotePrompt("correctness", "REMOTE CORRECTNESS"),
  security_system: validRemotePrompt("security", "REMOTE SECURITY"),
  architecture_system: validRemotePrompt("architecture", "REMOTE ARCHITECTURE"),
  synthesis_system: validRemoteSynthesisPrompt("REMOTE SYNTHESIS"),
};

const langfuseInputs = {
  "INPUT_LANGFUSE-PUBLIC-KEY": "pk-test",
  "INPUT_LANGFUSE-SECRET-KEY": "sk-test",
};

describe("Langfuse wiring", () => {
  it("builds no prompt client and no tracing when neither key is set", async () => {
    const { environment, promptClientConfigs, tracingConfigs, flushCount, entries } =
      harness(reviewEnv);

    await runAction(environment);

    expect(promptClientConfigs).toEqual([]);
    expect(tracingConfigs).toEqual([]);
    expect(flushCount()).toBe(0);
    // The default path stays silent about a feature nobody asked for.
    expect(
      events(entries).filter(
        (event) => typeof event === "string" && event.startsWith("langfuse."),
      ),
    ).toEqual([]);
  });

  it("fetches prompts and starts tracing when both keys are set", async () => {
    const {
      environment,
      promptClientConfigs,
      promptFetches,
      tracingConfigs,
      flushCount,
      entries,
    } = harness(
      { ...reviewEnv, ...langfuseInputs, GITHUB_SHA: "abc123" },
      pullRequestEvent(),
      { prompts: remotePrompts },
    );

    await runAction(environment);

    expect(promptClientConfigs).toEqual([
      {
        publicKey: "pk-test",
        secretKey: "sk-test",
        baseUrl: "https://cloud.langfuse.com",
      },
    ]);
    expect(promptFetches.map((fetch) => fetch.name).sort()).toEqual([
      "architecture_system",
      "correctness_system",
      "security_system",
      "synthesis_system",
    ]);
    expect(promptFetches.every((fetch) => fetch.label === "production")).toBe(true);
    // Fetching is not accepting: the contract guard could still reject all four.
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "langfuse.prompts.loaded",
        loadedCount: 4,
        fallbackCount: 0,
      }),
    );
    expect(tracingConfigs).toEqual([
      { baseUrl: "https://cloud.langfuse.com", release: "abc123" },
    ]);
    expect(flushCount()).toBe(1);
  });

  it("honours a custom host and prompt label", async () => {
    const { environment, promptClientConfigs, promptFetches } = harness(
      {
        ...reviewEnv,
        ...langfuseInputs,
        "INPUT_LANGFUSE-BASE-URL": "https://langfuse.internal",
        "INPUT_LANGFUSE-PROMPT-LABEL": "staging",
      },
      pullRequestEvent(),
      { prompts: remotePrompts },
    );

    await runAction(environment);

    expect(promptClientConfigs[0]?.baseUrl).toBe("https://langfuse.internal");
    expect(promptFetches.every((fetch) => fetch.label === "staging")).toBe(true);
  });

  it.each([
    ["INPUT_LANGFUSE-SECRET-KEY", "langfuse-secret-key"],
    ["INPUT_LANGFUSE-PUBLIC-KEY", "langfuse-public-key"],
  ])(
    "reports half-configured credentials and reviews anyway when %s is missing",
    async (variable, missingInput) => {
      const env: Record<string, string | undefined> = {
        ...reviewEnv,
        ...langfuseInputs,
      };
      delete env[variable];
      const { environment, promptClientConfigs, tracingConfigs, entries } =
        harness(env);

      await expect(runAction(environment)).resolves.toBeUndefined();

      expect(promptClientConfigs).toEqual([]);
      expect(tracingConfigs).toEqual([]);
      expect(entries).toContainEqual({
        level: "error",
        event: "langfuse.disabled_incomplete_credentials",
        missingInput,
      });
    },
  );

  it("never logs key material", async () => {
    const { environment, entries } = harness(
      { ...reviewEnv, ...langfuseInputs },
      pullRequestEvent(),
      { prompts: remotePrompts },
    );

    await runAction(environment);

    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("pk-test");
    expect(logged).not.toContain("sk-test");
  });

  it("falls back to the in-code prompts when every fetch fails", async () => {
    const { environment, entries } = harness(
      { ...reviewEnv, ...langfuseInputs },
      pullRequestEvent(),
      {
        prompts: {
          correctness_system: new Error("langfuse unavailable"),
          security_system: new Error("langfuse unavailable"),
          architecture_system: new Error("langfuse unavailable"),
          synthesis_system: new Error("langfuse unavailable"),
        },
      },
    );

    await expect(runAction(environment)).resolves.toBeUndefined();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "langfuse.prompts.loaded",
        loadedCount: 0,
        fallbackCount: 4,
      }),
    );
  });

  it("flushes spans even when the run fails after tracing started", async () => {
    const { environment, flushCount } = harness(
      { ...reviewEnv, ...langfuseInputs },
      pullRequestEvent(),
      { prompts: remotePrompts, modelError: new Error("model provider unavailable") },
    );

    await expect(runAction(environment)).rejects.toThrow();

    expect(flushCount()).toBe(1);
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

  it('runs the action when GITHUB_ACTIONS is exactly "true"', async () => {
    const { environment, readPaths, entries, exitCodes } = harness({
      ...reviewEnv,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
    });

    runEntrypoint(environment);
    await flush();

    expect(readPaths).toEqual(["/tmp/event.json"]);
    expect(events(entries)).toEqual(["review.skipped"]);
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
    // The import above already evaluated the guard with GITHUB_ACTIONS cleared.
    expect(process.exitCode).not.toBe(1);
  });
});

describe("actionEnvironment", () => {
  it("wires the real process environment and client factories", () => {
    const environment = actionEnvironment();
    expect(environment.env).toBe(process.env);
    expect(typeof environment.readEventFile).toBe("function");
    expect(typeof environment.createModelClient).toBe("function");
    expect(typeof environment.createTokenClient).toBe("function");
    expect(typeof environment.createPromptClient).toBe("function");
    expect(typeof environment.createLangfuseRuntime).toBe("function");
    expect(typeof environment.setExitCode).toBe("function");
    expect(typeof environment.logger.info).toBe("function");
    expect(typeof environment.logger.error).toBe("function");
  });
});
