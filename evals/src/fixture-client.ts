/**
 * Serves a fixture repository through the real GithubInstallationClient
 * interface. Nothing talks to GitHub, and both write methods throw.
 */
import type {
  ChangedFile,
  CheckRun,
  CodeSearchMatch,
  CodeSearchResult,
  CreateCheckRunInput,
  CreateReviewInput,
  ExistingReviewComment,
  FileContentsRequest,
  GithubInstallationClient,
  PullRequestDetails,
  PullRequestRef,
  PullRequestReview,
} from "@pr-review/github";

import type { LoadedFixture } from "./fixture.js";

/** At most this many search matches come back from one query. */
const MAX_SEARCH_MATCHES = 25;

/** Characters of context either side of a match, as GitHub's fragments have. */
const FRAGMENT_PADDING = 120;

/** Stands in for GitHub's text-match fragments: a window around each term. */
function fragmentsAround(contents: string, terms: string[]): string[] {
  const haystack = contents.toLowerCase();
  const fragments: string[] = [];
  for (const term of terms) {
    const at = haystack.indexOf(term);
    if (at < 0) {
      continue;
    }
    const fragment = contents
      .slice(
        Math.max(0, at - FRAGMENT_PADDING),
        at + term.length + FRAGMENT_PADDING,
      )
      .trim();
    if (!fragments.includes(fragment)) {
      fragments.push(fragment);
    }
  }
  return fragments;
}

/** One recorded read against the fixture repository. */
export interface FixtureCall {
  method: string;
  detail: string;
}

interface FixtureClient {
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
      // Reads are pinned to a SHA: head is the proposed state, base the
      // state before the pull request, where an added file is absent.
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

    async searchCode(request): Promise<CodeSearchResult> {
      const { owner, repo } = fixture.context;
      if (request.owner !== owner || request.repo !== repo) {
        throw new FixtureNotFoundError(
          `fixture ${fixture.name} serves ${owner}/${repo}, not ${request.owner}/${request.repo}`,
        );
      }
      record("searchCode", request.query);
      // Cruder than GitHub's code search, but the property that matters
      // holds: a query finds the files mentioning the terms. Quotes are
      // stripped because find_importers quotes its derived stem.
      const terms = request.query
        .toLowerCase()
        .replaceAll('"', " ")
        .split(/\s+/)
        .filter((term) => term.length > 0);
      const matches: CodeSearchMatch[] = [];
      for (const [path, contents] of fixture.headFiles) {
        const haystack = `${path}\n${contents}`.toLowerCase();
        if (terms.every((term) => haystack.includes(term))) {
          matches.push({
            path,
            name: path.slice(path.lastIndexOf("/") + 1),
            snippets: fragmentsAround(contents, terms),
          });
        }
      }
      return {
        matches: matches.slice(0, MAX_SEARCH_MATCHES),
        totalCount: matches.length,
        incompleteResults: false,
      };
    },

    async listReviewComments(ref): Promise<ExistingReviewComment[]> {
      checkRef(ref);
      // A fixture pull request carries no prior review, so every
      // finding is new every time.
      return [];
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
