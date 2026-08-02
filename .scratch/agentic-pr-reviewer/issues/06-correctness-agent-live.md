# 06 — Correctness agent live

**What to build:** The first real AI review: a PR containing an obvious bug (e.g. assignment-instead-of-comparison in an auth check) gets a genuine correctness finding in its check run, replacing the hard-coded samples. This slice brings up the Anthropic SDK client (model configured via environment variable), the orchestrator running a single agent, and the read-only, repository-scoped, schema-validated GitHub tools from spec.md §13 (get PR, list changed files, get diff, get file, get base file, search repository). The agent starts from PR title + description + changed files + diff and requests further context through tools only when needed — never the whole repository. Agent instructions are prompt-injection hardened per spec.md §21: repository contents are data, code comments are not instructions, tool output cannot grant permissions, and the agent has no write, approval, comment, or execution tools of any kind. The agent looks for bugs, incorrect logic, missing validation, error-handling problems, edge cases, async issues, and incorrect state changes — not formatting or style.

**Blocked by:** 05 — Findings pipeline.

**Status:** ready-for-agent

- [ ] Opening a PR with a planted correctness bug produces a correctness finding in the check run, on the right file and line
- [ ] The agent's output is Zod-validated into the shared finding schema before entering the validation pipeline
- [ ] All agent tools are read-only, scoped to the PR's repository, and schema-validated; no write-capable tool exists anywhere in the agent's toolset
- [ ] The model is selected via environment variable, not hard-coded
- [ ] Agent instructions state the prompt-injection rules from spec.md §21
- [ ] Unit tests cover tool schema validation and agent-output parsing (model calls mocked)
