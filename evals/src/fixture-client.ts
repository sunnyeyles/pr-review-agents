/**
 * Serves a fixture repository through the real GithubInstallationClient
 * interface. Nothing talks to GitHub, and every write method throws.
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
  ReviewThread,
  WriteFileRequest,
} from "@pr-review/github";

import type { LoadedFixture } from "./fixture.js";

/** At most this many search matches come back from one query. */
const MAX_SEARCH_MATCHES = 25;

/** Characters of context either side of a match, as GitHub's fragments have. */
const FRAGMENT_PADDING = 120;

/** Stands in for GitHub's text-match fragments: a window around each term. */
function fragmentsAround(
  contents: string,
  lowered: string,
  terms: string[],
): string[] {
  const windows = terms.flatMap((term) => {
    const at = lowered.indexOf(term);
    return at < 0
      ? []
      : [
          contents.slice(
            Math.max(0, at - FRAGMENT_PADDING),
            at + term.length + FRAGMENT_PADDING,
          ),
        ];
  });
  return [...new Set(windows)];
}

/** GitHub's grammar: a quoted phrase is one term, everything else splits on space. */
function searchTerms(query: string): string[] {
  return (query.toLowerCase().match(/"[^"]*"|\S+/g) ?? [])
    .map((term) => term.replaceAll('"', ""))
    .filter((term) => term.length > 0);
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
      const terms = searchTerms(request.query);
      const matches: CodeSearchMatch[] = [];
      for (const [path, contents] of fixture.headFiles) {
        const lowered = contents.toLowerCase();
        const haystack = `${path.toLowerCase()}\n${lowered}`;
        if (terms.every((term) => haystack.includes(term))) {
          matches.push({
            path,
            name: path.slice(path.lastIndexOf("/") + 1),
            snippets: fragmentsAround(contents, lowered, terms),
          });
        }
      }
      return {
        matches: matches.slice(0, MAX_SEARCH_MATCHES),
        totalCount: matches.length,
        incompleteResults: false,
      };
    },

    // A fixture has no commits; inventing history would make the eval lie.
    async listCommitShas(request): Promise<string[]> {
      record("listCommitShas", request.path);
      return [];
    },

    async listCommitFiles(request): Promise<string[]> {
      throw new FixtureNotFoundError(
        `fixture ${fixture.name} has no commit history, so ${request.sha} does not exist`,
      );
    },

    async listReviewComments(ref): Promise<ExistingReviewComment[]> {
      checkRef(ref);
      // A fixture pull request carries no prior review, so every
      // finding is new every time.
      return [];
    },

    async listReviewThreads(ref): Promise<ReviewThread[]> {
      checkRef(ref);
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

    async writeFileOnBranch(request: WriteFileRequest): Promise<void> {
      throw new Error(
        `the evaluation harness must never publish: writeFileOnBranch called for ` +
          `${request.owner}/${request.repo}@${request.branch}:${request.path}`,
      );
    },
  };

  return { client, calls };
}
