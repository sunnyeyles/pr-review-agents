/**
 * The fixture-backed GitHub client.
 *
 * The review agents reach for repository context through the six
 * read-only tools (@pr-review/ai's tools.ts), and those tools call a
 * GithubInstallationClient. Evaluations must give the model that real
 * tool surface — an agent that cannot read a neighbouring file reviews
 * a different pull request than the one a user would get — so the
 * fixture repository is served through the same interface instead of
 * the network. Nothing here talks to GitHub, and both write methods on
 * the interface throw: an evaluation that somehow reached the publish
 * path is a bug, not a passing run.
 */
import type {
  ChangedFile,
  CheckRun,
  CodeSearchMatch,
  CreateCheckRunInput,
  CreateReviewInput,
  FileContentsRequest,
  GithubInstallationClient,
  PullRequestDetails,
  PullRequestRef,
  PullRequestReview,
} from "@pr-review/github";

import type { LoadedFixture } from "./fixture.js";

/** At most this many search matches come back from one query. */
const MAX_SEARCH_MATCHES = 25;

/** One recorded read against the fixture repository. */
export interface FixtureCall {
  method: string;
  detail: string;
}

export interface FixtureClient {
  client: GithubInstallationClient;
  /** Every read the agents performed, in order. */
  calls: FixtureCall[];
}

/** Thrown for a read the fixture repository cannot answer. */
class FixtureNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureNotFoundError";
  }
}

export function createFixtureClient(fixture: LoadedFixture): FixtureClient {
  const calls: FixtureCall[] = [];
  const record = (method: string, detail: string): void => {
    calls.push({ method, detail });
  };

  const checkRef = (ref: PullRequestRef): void => {
    const { owner, repo, pullRequest } = fixture.context;
    if (
      ref.owner !== owner ||
      ref.repo !== repo ||
      ref.pullRequestNumber !== pullRequest.number
    ) {
      throw new FixtureNotFoundError(
        `fixture ${fixture.name} serves ${owner}/${repo}#${pullRequest.number}, not ` +
          `${ref.owner}/${ref.repo}#${ref.pullRequestNumber}`,
      );
    }
  };

  const client: GithubInstallationClient = {
    async getPullRequest(ref): Promise<PullRequestDetails> {
      checkRef(ref);
      record("getPullRequest", `#${ref.pullRequestNumber}`);
      return fixture.pullRequest;
    },

    async listChangedFiles(ref): Promise<ChangedFile[]> {
      checkRef(ref);
      record("listChangedFiles", `#${ref.pullRequestNumber}`);
      return fixture.changedFiles.map((file) => ({ ...file }));
    },

    async getDiff(ref): Promise<string> {
      checkRef(ref);
      record("getDiff", `#${ref.pullRequestNumber}`);
      return fixture.diff;
    },

    async getFileContents(request: FileContentsRequest): Promise<string> {
      const { owner, repo } = fixture.context;
      if (request.owner !== owner || request.repo !== repo) {
        throw new FixtureNotFoundError(
          `fixture ${fixture.name} serves ${owner}/${repo}, not ${request.owner}/${request.repo}`,
        );
      }
      // Reads are pinned to a SHA by the tool scope: the head SHA is
      // the proposed state, the base SHA the state before the pull
      // request — where a file the pull request adds does not exist.
      const atHead = request.ref === fixture.pullRequest.headSha;
      const tree = atHead ? fixture.headFiles : fixture.baseFiles;
      record("getFileContents", `${request.path} @ ${atHead ? "head" : "base"}`);
      const contents = tree.get(request.path);
      if (contents === undefined) {
        throw new FixtureNotFoundError(
          `Not Found: ${request.path} does not exist at ${request.ref}`,
        );
      }
      return contents;
    },

    async searchCode(request): Promise<CodeSearchMatch[]> {
      const { owner, repo } = fixture.context;
      if (request.owner !== owner || request.repo !== repo) {
        throw new FixtureNotFoundError(
          `fixture ${fixture.name} serves ${owner}/${repo}, not ${request.owner}/${request.repo}`,
        );
      }
      record("searchCode", request.query);
      // GitHub's code search is far cleverer than this, but the
      // property that matters for a review is the same: a query finds
      // the files in this repository that mention the terms.
      const terms = request.query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0);
      const matches: CodeSearchMatch[] = [];
      for (const [path, contents] of fixture.headFiles) {
        const haystack = `${path}\n${contents}`.toLowerCase();
        if (terms.every((term) => haystack.includes(term))) {
          matches.push({ path, name: path.slice(path.lastIndexOf("/") + 1) });
        }
      }
      return matches.slice(0, MAX_SEARCH_MATCHES);
    },

    async createCheckRun(input: CreateCheckRunInput): Promise<CheckRun> {
      throw new Error(
        `the evaluation harness must never publish: createCheckRun called for ` +
          `${input.owner}/${input.repo}@${input.headSha}`,
      );
    },

    async createReview(input: CreateReviewInput): Promise<PullRequestReview> {
      throw new Error(
        `the evaluation harness must never publish: createReview called for ` +
          `${input.owner}/${input.repo}#${input.pullRequestNumber}`,
      );
    },
  };

  return { client, calls };
}
