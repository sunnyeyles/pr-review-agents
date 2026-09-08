/**
 * The read-only PR loading and check-run publishing surface. Implemented
 * against Octokit in app.ts; tests stub it structurally.
 */

/** The name every check run this system publishes must use. */
export const CHECK_RUN_NAME = "AI PR Review";

/** Identifies one pull request within an installation's repositories. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  pullRequestNumber: number;
}

/** PR title, description, and metadata the review pipeline consumes. */
export interface PullRequestDetails {
  number: number;
  title: string;
  body: string | null;
  author: string | null;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

/** A request for one file's contents at a specific commit SHA or ref. */
export interface FileContentsRequest {
  owner: string;
  repo: string;
  /** Repository-relative path, e.g. "src/index.ts". */
  path: string;
  /** Commit SHA (or ref) to read the file at. */
  ref: string;
}

/** A code search request; always scoped to the single named repository. */
export interface CodeSearchRequest {
  owner: string;
  repo: string;
  query: string;
}

/** One code search match within the requested repository. */
export interface CodeSearchMatch {
  /** Repository-relative path of the matching file. */
  path: string;
  /** Base name of the matching file. */
  name: string;
  /** Verbatim fragments from the default branch's index; no line numbers. */
  snippets: readonly string[];
}

/** A code search result set, with the totals GitHub reports alongside it. */
export interface CodeSearchResult {
  /** Matches GitHub returned; never more than one page. */
  matches: CodeSearchMatch[];
  /** Total matches in the repository, which may exceed `matches.length`. */
  totalCount: number;
  /** True when GitHub timed out the query and returned a partial answer. */
  incompleteResults: boolean;
}

/** A request for the commits that touched one path, newest first. */
export interface CommitHistoryRequest {
  owner: string;
  repo: string;
  /** Repository-relative path; only commits touching it are returned. */
  path: string;
  /** Commits to return. GitHub caps a page at 100. */
  limit: number;
}

/** A request for the files one commit changed. */
export interface CommitFilesRequest {
  owner: string;
  repo: string;
  sha: string;
}

/** One changed file in a PR; patch is absent for e.g. binary files. */
export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | undefined;
}

export type CheckRunConclusion = "success" | "failure" | "neutral";

export type AnnotationLevel = "notice" | "warning" | "failure";

/** One inline annotation; the checks API accepts at most 50 per request. */
export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: AnnotationLevel;
  message: string;
  title?: string | undefined;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string | undefined;
  annotations?: CheckRunAnnotation[] | undefined;
}

/** Every check run is published as CHECK_RUN_NAME; the name is not configurable. */
export interface CreateCheckRunInput {
  owner: string;
  repo: string;
  headSha: string;
  conclusion: CheckRunConclusion;
  output: CheckRunOutput;
}

export interface CheckRun {
  id: number;
}

/**
 * One inline comment on a review. `line` is a new-side line number that
 * must fall inside the diff; GitHub rejects the whole review otherwise.
 */
export interface ReviewComment {
  path: string;
  line: number;
  /** First line of a multi-line comment; omit to comment on `line` alone. */
  startLine?: number | undefined;
  body: string;
}

/** Every review is posted as a COMMENT, never APPROVE or REQUEST_CHANGES. */
export interface CreateReviewInput {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  /** Head SHA the comments are anchored to. */
  commitSha: string;
  body: string;
  comments: ReviewComment[];
}

export interface PullRequestReview {
  id: number;
}

/** An inline comment already on the pull request, from any author. */
export interface ExistingReviewComment {
  body: string;
}

/** One file's complete new contents in a commit built over the API. */
export interface CommitFileChange {
  path: string;
  content: string;
}

/** A request for one branch's current tip commit. */
export interface BranchTipRequest {
  owner: string;
  repo: string;
  /** Branch name without the `refs/heads/` prefix. */
  branch: string;
}

/** A request for one commit's message. */
export interface CommitMessageRequest {
  owner: string;
  repo: string;
  sha: string;
}

/**
 * One commit fast-forwarded onto `branch`. `baseSha` is both the parent and
 * the tip the update requires, so a concurrent push is rejected, not overwritten.
 */
export interface CreateCommitInput {
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  message: string;
  files: readonly CommitFileChange[];
}

export interface CommitRef {
  sha: string;
}

/**
 * Repository-scoped throughout. Read-only except createCheckRun,
 * createReview, and createCommitOnBranch.
 */
export interface GithubInstallationClient {
  getPullRequest(ref: PullRequestRef): Promise<PullRequestDetails>;
  listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]>;
  getDiff(ref: PullRequestRef): Promise<string>;
  /** Reads one file's decoded contents at a specific SHA. Read-only. */
  getFileContents(request: FileContentsRequest): Promise<string>;
  /** Searches code within the single named repository. Read-only. */
  searchCode(request: CodeSearchRequest): Promise<CodeSearchResult>;
  /** Default-branch commits touching one path, newest first; an unmerged addition has none. */
  listCommitShas(request: CommitHistoryRequest): Promise<string[]>;
  /** Paths one commit changed; GitHub caps this at 300, so a sweep comes back short. */
  listCommitFiles(request: CommitFilesRequest): Promise<string[]>;
  /** Every inline review comment already on the pull request. */
  listReviewComments(ref: PullRequestRef): Promise<ExistingReviewComment[]>;
  /** The commit one branch currently points at. */
  getBranchTip(request: BranchTipRequest): Promise<string>;
  /** One commit's message, used to recognise this system's own commits. */
  getCommitMessage(request: CommitMessageRequest): Promise<string>;
  createCheckRun(input: CreateCheckRunInput): Promise<CheckRun>;
  /** Publishes one advisory review with inline comments. */
  createReview(input: CreateReviewInput): Promise<PullRequestReview>;
  /** Commits file contents onto a branch. Write; never forces. */
  createCommitOnBranch(input: CreateCommitInput): Promise<CommitRef>;
}
