/**
 * Drives the real review pipeline for one fixture. Only the GitHub client and
 * the publish step differ from production.
 */
import {
  createModelClient,
  createReviewAgents,
  createSynthesiser,
  type ReviewAgent,
  type AgentDefinition,
  type Synthesiser,
} from "@pr-review/ai";
import type { GithubInstallationClient } from "@pr-review/github";
import {
  createCapturingLogger,
  type CapturedLogEvent,
  type StructuredLogger,
} from "@pr-review/logging";
import {
  reviewPullRequest,
  runReviewPipeline,
  type RenderedCheckRun,
  type ReviewPipelineResult,
} from "@pr-review/reviewer";

import { createFixtureClient, type FixtureCall } from "./fixture-client.js";
import type { LoadedFixture } from "./fixture.js";
import type { ModelAccess } from "./model-access.js";

/** The model-facing half of a review; the harness's own tests inject scripted agents. */
export interface FixtureReviewDeps {
  /** The agent set the review gates by path and then runs. */
  agents: readonly AgentDefinition[];
  /** Built over the review's own logger, so every event of one fixture lands together. */
  createAgents: (
    github: GithubInstallationClient,
    logger: StructuredLogger,
    agents: readonly AgentDefinition[],
  ) => readonly ReviewAgent[];
  synthesiser: Synthesiser;
  /** Receives events live, alongside the capturing logger the report is built from. */
  logger?: StructuredLogger | undefined;
}

/** Everything one fixture review produced, for expectations to judge. */
export interface FixtureReview {
  fixture: LoadedFixture;
  /** The pipeline's own result: candidates, failures, final findings. */
  result: ReviewPipelineResult;
  /** The check run a real review would have published. */
  rendered: RenderedCheckRun;
  /** Every repository read the agents made through their tools. */
  calls: readonly FixtureCall[];
  /** The lifecycle events the review emitted. */
  events: readonly CapturedLogEvent[];
  durationMs: number;
}

/**
 * The production wiring, over the agent set the caller evaluates —
 * normally this repository's own configuration.
 */
export function modelBackedDeps(
  access: ModelAccess,
  logger: StructuredLogger | undefined,
  agents: readonly AgentDefinition[],
): FixtureReviewDeps {
  const model = createModelClient({
    provider: access.provider,
    apiKey: access.apiKey,
  });
  const modelId = access.model;
  return {
    agents,
    createAgents: (github, reviewLogger, activeAgents) =>
      createReviewAgents(
        { model, modelId, github, logger: reviewLogger },
        activeAgents,
      ),
    synthesiser: createSynthesiser({ model, modelId, agents }),
    logger,
  };
}

/** Feeds every event to both loggers, in order. */
function tee(first: StructuredLogger, second: StructuredLogger | undefined): StructuredLogger {
  if (second === undefined) {
    return first;
  }
  return {
    info(event, fields) {
      first.info(event, fields);
      second.info(event, fields);
    },
    error(event, fields) {
      first.error(event, fields);
      second.error(event, fields);
    },
  };
}

/** Runs one fixture through the full review and returns what it produced. */
export async function runFixtureReview(
  fixture: LoadedFixture,
  deps: FixtureReviewDeps,
): Promise<FixtureReview> {
  const { client, calls } = createFixtureClient(fixture);
  const captured = createCapturingLogger();
  const logger = tee(captured.logger, deps.logger);

  let rendered: RenderedCheckRun | undefined;
  const startedAt = Date.now();
  const result = await reviewPullRequest(
    {
      owner: fixture.context.owner,
      repo: fixture.context.repo,
      pullRequestNumber: fixture.pullRequest.number,
      headSha: fixture.pullRequest.headSha,
    },
    {
      client,
      agents: deps.agents,
      runReviewPipeline: (reviewClient, context, activeAgents) =>
        runReviewPipeline(
          deps.createAgents(reviewClient, logger, activeAgents),
          deps.synthesiser,
          context,
        ),
      // The steps an evaluation replaces.
      publishReview: async (_target, checkRun) => {
        rendered = checkRun;
      },
      // Nothing is sent, and false keeps the annotations on the check
      // run an evaluation judges.
      publishReviewComments: async () => false,
      logger,
    },
  );
  const durationMs = Date.now() - startedAt;

  if (rendered === undefined) {
    throw new Error(
      `the review of fixture ${fixture.name} finished without rendering a check run`,
    );
  }

  return {
    fixture,
    result,
    rendered,
    calls,
    events: captured.entries,
    durationMs,
  };
}
