/**
 * Drives the real review pipeline for one fixture. Only the GitHub client and
 * the publish step differ from production.
 */
import {
  createLanguageModel,
  createReviewAgents,
  createSynthesiser,
  type ReviewAgent,
  type AgentDefinition,
  type Synthesiser,
} from "@pr-review/ai";
import type { GithubInstallationClient } from "@pr-review/github";
import type { StructuredLogger } from "@pr-review/logging";
import {
  reviewPullRequest,
  runReviewPipeline,
  type RenderedCheckRun,
  type ReviewPipelineResult,
} from "@pr-review/reviewer";

import { createFixtureClient } from "./fixture-client.js";
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
  logger: StructuredLogger;
}

/** Everything one fixture review produced, for expectations to judge. */
export interface FixtureReview {
  fixture: LoadedFixture;
  /** The pipeline's own result: candidates, failures, final findings. */
  result: ReviewPipelineResult;
  /** The check run a real review would have published. */
  rendered: RenderedCheckRun;
}

/**
 * The production wiring, over the agent set the caller evaluates —
 * normally this repository's own configuration.
 */
export function modelBackedDeps(
  access: ModelAccess,
  logger: StructuredLogger,
  agents: readonly AgentDefinition[],
): FixtureReviewDeps {
  const createModel = (modelId: string) =>
    createLanguageModel({
      provider: access.provider,
      apiKey: access.apiKey,
      modelId,
    });
  const model = createModel(access.model);
  return {
    agents,
    createAgents: (github, reviewLogger, activeAgents) =>
      createReviewAgents(
        { model, createModel, github, logger: reviewLogger },
        activeAgents,
      ),
    synthesiser: createSynthesiser({ model, agents }),
    logger,
  };
}

/** Runs one fixture through the full review and returns what it produced. */
export async function runFixtureReview(
  fixture: LoadedFixture,
  deps: FixtureReviewDeps,
): Promise<FixtureReview> {
  const { client } = createFixtureClient(fixture);
  const { logger } = deps;

  let rendered: RenderedCheckRun | undefined;
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
      // An evaluation has no comment surface, so the check run keeps the
      // annotations it judges.
      publishReviewComments: async () => "unavailable",
      logger,
    },
  );

  if (rendered === undefined) {
    throw new Error(
      `the review of fixture ${fixture.name} finished without rendering a check run`,
    );
  }

  return { fixture, result, rendered };
}
