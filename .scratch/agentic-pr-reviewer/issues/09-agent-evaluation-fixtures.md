# 09 — Agent evaluation fixtures

**What to build:** A runnable evaluation harness that measures review quality against known fixtures, so quality regressions are caught before users see them. Three fixtures from spec.md §27: a correctness fixture containing an assignment-instead-of-comparison bug in an admin check (must produce a correctness finding), a security fixture where a database query fetches a customer record without tenant validation (must produce a security finding), and a clean fixture (must produce zero findings — a reviewer that always finds issues is low quality). The harness runs the real agent pipeline against these fixtures and reports pass/fail per expectation.

**Blocked by:** 08 — Synthesiser (evaluates the pipeline in its final shape).

**Status:** ready-for-agent

- [ ] One command runs the full evaluation suite and reports pass/fail per fixture
- [ ] The correctness fixture yields at least one correctness finding on the planted bug
- [ ] The security fixture yields at least one security finding on the missing tenant validation
- [ ] The clean fixture yields zero findings through the full pipeline
- [ ] Evaluations are excluded from the fast unit-test run (they call the real model) but runnable in CI on demand
