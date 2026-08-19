# 15 — Agent evaluation fixtures

**What to build:** A runnable evaluation harness that measures whether the reviewer is any *good*, as opposed to whether its plumbing works. Every test in the suite today proves data moves correctly — that the three agents run concurrently, that a failed agent degrades cleanly into a partial review, that deterministic validation drops findings naming files the PR never touched — and none of them assert that a real bug placed in front of the reviewer actually gets reported, or that a clean diff comes back clean. This ticket realises the never-built ticket 09 (from spec.md §27) and closes exactly that gap, so it supersedes 09 and nobody should build both. One command runs the real end-to-end pipeline — agent fan-out, synthesis, and the deterministic validation step, not a stubbed subset — against three fixtures and reports pass/fail per expectation. The fixtures are unchanged from ticket 09: a correctness fixture containing an assignment-instead-of-comparison bug inside an admin check, which must produce a correctness finding; a security fixture where a database query fetches a customer record without validating the tenant, which must produce a security finding; and a clean fixture that must produce zero findings, because a reviewer that always finds something is a low-quality reviewer. Because these call the real model they are non-deterministic and cost tokens, so they must sit outside the fast unit run while staying runnable in CI on demand. Where the harness needs a deterministic seam around the model boundary — fixture context construction, transcript shaping, anything that would otherwise duplicate a fake — reuse the existing scripted agent test-support helpers in `packages/ai` rather than inventing a second set of fakes.

**Blocked by:** 12 — Collapse the duplicate changedFiles channel (the evaluation harness drives the pipeline, and its signature changes).

**Status:** ready-for-agent

- [ ] One command runs the full evaluation suite and reports pass/fail per fixture
- [ ] The correctness fixture yields at least one correctness finding on the planted bug
- [ ] The security fixture yields at least one security finding on the missing tenant validation
- [ ] The clean fixture yields zero findings through the full pipeline
- [ ] Evaluations are excluded from the fast unit-test run (they call the real model) but runnable in CI on demand
- [ ] The harness drives the real end-to-end pipeline — concurrent agent fan-out, synthesis, and deterministic validation — rather than invoking a single agent or a stubbed subset
- [ ] A failing expectation reports which fixture and which expectation failed, and the harness reuses the scripted agent test-support helpers in `packages/ai` for any deterministic seam it needs
