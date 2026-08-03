/**
 * Shared fixtures and scripted fakes for the agent tests
 * (agent-runtime.test.ts, agents.test.ts). Tests only: this module is
 * not exported from the package and is never imported by production
 * code. No real network anywhere — the Anthropic client and the GitHub
 * installation client are structural fakes.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChangedFile,
  GithubInstallationClient,
  PullRequestDetails,
} from "@pr-review/github";
import type { ReviewFinding } from "@pr-review/schemas";
import { vi } from "vitest";

import type { ReviewContext } from "./review-types.js";

export const headSha = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
export const baseSha = "0000000000000000000000000000000000000000";

export const pullRequest: PullRequestDetails = {
  number: 42,
  title: "Add admin gating to the sessions endpoint",
  body: "Gates session listing behind an admin check.",
  state: "open",
  author: "octocat",
  baseRef: "main",
  baseSha,
  headRef: "feature/admin-gate",
  headSha,
};

export const changedFiles: ChangedFile[] = [
  {
    filename: "src/sessions.ts",
    status: "modified",
    additions: 3,
    deletions: 0,
    patch: "@@ -40,2 +40,5 @@",
  },
];

export const context: ReviewContext = {
  owner: "octo-org",
  repo: "example-service",
  pullRequest,
  changedFiles,
  diff: "diff --git a/src/sessions.ts b/src/sessions.ts\n+if ((user.isAdmin = true)) {\n",
};

/** A schema-valid candidate finding in the given category. */
export function makeFinding(
  category: ReviewFinding["category"],
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    file: "src/sessions.ts",
    line: 42,
    category,
    severity: "high",
    title: `A ${category} problem in the sessions endpoint`,
    explanation: `Concrete ${category} explanation.`,
    confidence: 0.95,
    ...overrides,
  };
}

/** Wraps findings in the final-JSON message shape agents must emit. */
export function finalFindingsJson(findings: readonly ReviewFinding[]): string {
  return JSON.stringify({ findings });
}

export function textBlock(text: string): Anthropic.Messages.TextBlock {
  return { type: "text", text, citations: null };
}

export function toolUseBlock(
  id: string,
  name: string,
  input: unknown,
): Anthropic.Messages.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

export function message(
  content: Anthropic.Messages.ContentBlock[],
  stopReason: Anthropic.Messages.Message["stop_reason"],
  usage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 1,
    outputTokens: 1,
  },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test-model",
    container: null,
    content,
    stop_reason: stopReason,
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

/** A scripted fake Anthropic client that replays queued responses. */
export function makeAnthropic(responses: Anthropic.Messages.Message[]) {
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
  return { anthropic: { messages: { create } }, create };
}

export function makeGithub() {
  return {
    getPullRequest: vi.fn(async () => pullRequest),
    listChangedFiles: vi.fn(async () => changedFiles),
    getDiff: vi.fn(async () => context.diff),
    getFileContents: vi.fn(async () => "export const sessions = [];\n"),
    searchCode: vi.fn(async () => [{ path: "src/sessions.ts", name: "sessions.ts" }]),
    createCheckRun: vi.fn(async () => ({ id: 987 })),
  } satisfies GithubInstallationClient;
}
