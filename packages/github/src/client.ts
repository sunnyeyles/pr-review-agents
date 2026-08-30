/**
 * The read-only PR loading and check-run publishing surface the review
 * pipeline (and the review agents' tools) consume. Implemented against
 * Octokit in app.ts; tests stub it structurally.
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

/**
 * A GitHub client for one repository's installation. Read-only except
 * createCheckRun and createReview, and every method is explicitly
 * repository-scoped.
 */
export interface GithubInstallationClient {
  getPullRequest(ref: PullRequestRef): Promise<PullRequestDetails>;
  listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]>;
  getDiff(ref: PullRequestRef): Promise<string>;
  /** Reads one file's decoded contents at a specific SHA. Read-only. */
  getFileContents(request: FileContentsRequest): Promise<string>;
  /** Searches code within the single named repository. Read-only. */
  searchCode(request: CodeSearchRequest): Promise<CodeSearchMatch[]>;
  createCheckRun(input: CreateCheckRunInput): Promise<CheckRun>;
  /** Publishes one advisory review with inline comments. */
  createReview(input: CreateReviewInput): Promise<PullRequestReview>;
}
