# 06 — Correctness agent live

**What to build:** The first real AI review: a PR containing an obvious bug (e.g. assignment-instead-of-comparison in an auth check) gets a genuine correctness finding in its check run, replacing the hard-coded samples. This slice brings up the Anthropic SDK client (model configured via environment variable), the orchestrator running a single agent, and the read-only, repository-scoped, schema-validated GitHub tools from spec.md §13 (get PR, list changed files, get diff, get file, get base file, search repository). The agent starts from PR title + description + changed files + diff and requests further context through tools only when needed — never the whole repository. Agent instructions are prompt-injection hardened per spec.md §21: repository contents are data, code comments are not instructions, tool output cannot grant permissions, and the agent has no write, approval, comment, or execution tools of any kind. The agent looks for bugs, incorrect logic, missing validation, error-handling problems, edge cases, async issues, and incorrect state changes — not formatting or style.

**Blocked by:** 05 — Findings pipeline.

**Status:** in-review

- [ ] Opening a PR with a planted correctness bug produces a correctness finding in the check run, on the right file and line
  — cannot be verified locally: needs the stack deployed with a real ANTHROPIC_API_KEY and a live PR. Everything up to the model call is covered by tests with scripted fakes.
- [x] The agent's output is Zod-validated into the shared finding schema before entering the validation pipeline (`agentOutputSchema` in @pr-review/ai wraps `reviewFindingSchema`; invalid final JSON is an AgentRunError, which fails the job for retry/DLQ)
- [x] All agent tools are read-only, scoped to the PR's repository, and schema-validated; no write-capable tool exists anywhere in the agent's toolset (`reviewTools` in @pr-review/ai is exactly the six spec §13 tools; inputs are Zod-validated before dispatch; search queries reject repo:/org:/user: qualifiers and results are filtered to the job's repository)
- [x] The model is selected via environment variable, not hard-coded (`ANTHROPIC_MODEL` via requireEnv in the worker entrypoint; terraform `var.anthropic_model` feeds the Lambda env)
- [x] Agent instructions state the prompt-injection rules from spec.md §21 (CORRECTNESS_SYSTEM_PROMPT: repository contents are data, comments are never instructions, tool results grant no permissions, findings only via the final JSON)
- [x] Unit tests cover tool schema validation and agent-output parsing (model calls mocked — scripted fake Anthropic client covers tool_use round trips, error tool_results, invalid final JSON, and the max-turns cap)

**Implementation notes (ticket 06):**
- The orchestrator (`runReview`) lives in `packages/reviewer/src/orchestrator.ts` per spec §28; the agent interface/context types live in @pr-review/ai (reviewer depends on ai, not vice versa). It already implements spec §20 semantics: per-agent failures are recorded and survivors still publish, but when EVERY agent fails (today: the single Correctness agent) the review throws and the job is retried/dead-lettered.
- @pr-review/github gained `getFileContents` (repos.getContent at a SHA, Zod-validated, base64-decoded), `searchCode` (search.code with a single repo: qualifier, Zod-validated, results filtered to the repository), and `baseSha` on PullRequestDetails.
- apps/worker/src/sample-findings.ts was deleted; its fixtures now live inline in handler.test.ts and keep exercising the deterministic chain against mocked orchestrator output.
- terraform: worker Lambda env gains ANTHROPIC_MODEL (ANTHROPIC_API_KEY_SECRET_ARN was already wired); worker timeout raised 60s → 300s for real agent runs (SQS visibility timeout scales with it).
