# 07 — Three agents concurrently + partial failure

**What to build:** A PR review now runs all three lenses — Correctness, Security, and Architecture — concurrently, and one failing agent no longer sinks the review: the check run still publishes the successful agents' findings and notes which lens failed. The Security agent looks for authentication/authorisation issues, cross-tenant access, injection, secret leakage, unsafe user input, sensitive logging, and privilege issues, preferring no finding over a speculative one. The Architecture agent looks for incorrect abstractions, duplication, bad dependencies, package-boundary violations, ignored existing patterns, and misplaced business logic — and must retrieve surrounding repository context via its tools before making architectural claims. Orchestration uses settled-promise semantics (spec.md §20) so each agent's outcome is independent.

**Blocked by:** 06 — Correctness agent live.

**Status:** done

- [x] All three agents run concurrently against the same PR context and each returns schema-validated findings in its own category
- [x] With one agent forced to fail, the check run still publishes the other two agents' findings
- [x] Security and Architecture agents carry the same prompt-injection hardening and read-only toolset as Correctness
- [x] Unit tests cover the partial-failure path (one failed, two succeeded) and the all-failed path

**Verification notes (2026-08-02):** All criteria verified locally with mocked model/GitHub clients (no network): `pnpm typecheck` clean, `pnpm test` 20 files / 209 tests green, `pnpm build` produces both Lambda bundles. Implementation notes: the shared agentic loop lives in `packages/ai/src/agent-runtime.ts` parameterised by a `ReviewLens`; the three lenses are thin factories in `packages/ai/src/agents.ts`. Category integrity: the runtime filters each agent's validated findings to its own category (leaked cross-category findings are dropped, not re-stamped). The check run notes failed lenses by name only (error detail stays in `agent.failed` logs), and a zero-finding run with a failed lens concludes "neutral", not "success". All-failed reviews throw from `runReview`, making the job an SQS batch item failure (retry/DLQ). Not verifiable locally: real concurrent behaviour against the live Anthropic/GitHub APIs and actual SQS retry/DLQ wiring — both exercised only in deployment.
