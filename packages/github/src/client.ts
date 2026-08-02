/**
 * The read-only PR loading and check-run publishing surface the worker
 * (and later the review agents' tools) consume. Implemented against
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
  state: string;
  author: string | null;
  baseRef: string;
  headRef: string;
  headSha: string;
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

/**
 * One inline annotation on a check run, in the shape the GitHub checks
 * API expects. The API accepts at most 50 annotations per request.
 */
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

/**
 * Input for publishing a completed check run. The name is not
 * configurable: every check run is published as CHECK_RUN_NAME.
 */
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
 * A GitHub client authenticated as one App installation. Everything is
 * read-only except createCheckRun, the system's single write path.
 */
export interface GithubInstallationClient {
  getPullRequest(ref: PullRequestRef): Promise<PullRequestDetails>;
  listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]>;
  getDiff(ref: PullRequestRef): Promise<string>;
  createCheckRun(input: CreateCheckRunInput): Promise<CheckRun>;
}

/** Seam for obtaining an installation-authenticated client. */
export type InstallationClientFactory = (
  installationId: number,
) => GithubInstallationClient;
