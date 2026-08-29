/**
 * Driving the REAL review for one fixture.
 *
 * This is deliberately the whole pipeline, not a convenient slice of
 * it: reviewPullRequest loads the pull request through the (fixture-
 * backed) GitHub client, runReviewPipeline fans the selected agents out
 * as concurrent graph nodes, joins their candidates with the partial-
 * failure rule, refines them through the Synthesiser, and runs the
 * deterministic validation chain; renderCheckRun then turns the
 * survivors into the check run a user would see. Everything an
 * evaluation asserts on is what a real pull request would have got.
 *
 * The wiring in `modelBackedDeps` is the same wiring the action
 * entrypoint uses (apps/action/src/index.ts) — same agent factory,
 * same shared Anthropic client and model for the agents and the
 * Synthesiser. Only two things differ, and both are the point of an
 * evaluation rather than a shortcut around it: the GitHub client
 * serves a fixture repository, and the publish step captures the
 * rendered check run instead of sending it to GitHub.
 */
import {
  createAnthropicClient,
  createReviewAgents,
  reviewLenses,
  type ReviewAgent,
  type ReviewLens,
} from "@pr-review/ai";
import type { GithubInstallationClient } from "@pr-review/github";
import {
  createCapturingLogger,
  createLogger,
  type CapturedLogEvent,
  type StructuredLogger,
} from "@pr-review/logging";
import {
  createSynthesiser,
  reviewPullRequest,
  runReviewPipeline,
  type RenderedCheckRun,
  type ReviewPipelineResult,
  type Synthesiser,
} from "@pr-review/reviewer";

import { createFixtureClient, type FixtureCall } from "./fixture-client.js";
import type { LoadedFixture } from "./fixture.js";
import type { ModelAccess } from "./model-access.js";

/**
 * The model-facing half of a review, injected so the evaluations can
 * run against the real API while the harness's own tests run the same
 * pipeline against scripted agents.
 */
export interface FixtureReviewDeps {
  /**
   * Builds the review agents over the fixture-backed GitHub client and
   * the review's logger, so every lifecycle event of one fixture — the
   * agents' included — lands in the same place.
   */
  createAgents: (
    github: GithubInstallationClient,
    logger: StructuredLogger,
  ) => readonly ReviewAgent[];
  synthesiser: Synthesiser;
  /**
   * Receives every lifecycle event as it happens, in addition to the
   * capturing logger the report is built from. The evaluations pass
   * the console logger so a long run shows progress.
   */
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
  /** The lifecycle events the review emitted (spec §26). */
  events: readonly CapturedLogEvent[];
  durationMs: number;
}

/**
 * The production wiring: real Anthropic client, real agents, real
 * Synthesiser.
 *
 * `lenses` narrows the agent set exactly as the action's `agents`
 * input does. It defaults to every lens, so a bare `pnpm eval`
 * measures the review a user actually gets; narrowing it evaluates one
 * lens at roughly its own share of the cost.
 */
export function modelBackedDeps(
  access: ModelAccess,
  logger?: StructuredLogger,
  lenses: readonly ReviewLens[] = reviewLenses,
): FixtureReviewDeps {
  const anthropic = createAnthropicClient({ apiKey: access.apiKey });
  const model = access.model;
  return {
    createAgents: (github, reviewLogger) =>
      createReviewAgents(
        { anthropic, model, github, logger: reviewLogger },
        lenses,
      ),
    synthesiser: createSynthesiser({ anthropic, model }),
    logger,
  };
}

/** Feeds every event to both loggers, in order. */
function tee(first: StructuredLogger, second: StructuredLogger | undefined): StructuredLogger {
  if (second === undefined) {
    return first;
  }
  return createLogger((level, event, fields) => {
    first[level](event, fields);
    second[level](event, fields);
  });
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
      runReviewPipeline: (reviewClient, context) =>
        runReviewPipeline(
          deps.createAgents(reviewClient, logger),
          deps.synthesiser,
          context,
        ),
      // The only step an evaluation replaces: the review is judged
      // here rather than published to GitHub.
      publishReview: async (_target, checkRun) => {
        rendered = checkRun;
      },
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
