# 07 — Three agents concurrently + partial failure

**What to build:** A PR review now runs all three lenses — Correctness, Security, and Architecture — concurrently, and one failing agent no longer sinks the review: the check run still publishes the successful agents' findings and notes which lens failed. The Security agent looks for authentication/authorisation issues, cross-tenant access, injection, secret leakage, unsafe user input, sensitive logging, and privilege issues, preferring no finding over a speculative one. The Architecture agent looks for incorrect abstractions, duplication, bad dependencies, package-boundary violations, ignored existing patterns, and misplaced business logic — and must retrieve surrounding repository context via its tools before making architectural claims. Orchestration uses settled-promise semantics (spec.md §20) so each agent's outcome is independent.

**Blocked by:** 06 — Correctness agent live.

**Status:** ready-for-agent

- [ ] All three agents run concurrently against the same PR context and each returns schema-validated findings in its own category
- [ ] With one agent forced to fail, the check run still publishes the other two agents' findings
- [ ] Security and Architecture agents carry the same prompt-injection hardening and read-only toolset as Correctness
- [ ] Unit tests cover the partial-failure path (one failed, two succeeded) and the all-failed path
