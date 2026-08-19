# 12 — Collapse the duplicate changedFiles channel

**What to build:** A single source of truth for the PR's changed-file list inside the review pipeline. Today that list is carried in two independent places that nothing keeps in sync: `runReviewPipeline` takes `changedFiles` as a separate fourth argument while also receiving the same list inside the `ReviewContext` it is handed, and the graph state declares both as separate channels. The three review agents read the copy inside the context; the final deterministic validation node reads the standalone copy. Because validation rejects any finding whose file is absent from the changed-file list, a caller that passes a list differing from the one in the context would cause every finding the agents produced to be silently dropped and the review to publish clean — the composition root passes `context.changedFiles` today, which is correct, but that is a convention nothing enforces. Make `ReviewContext` authoritative: remove the redundant parameter and the redundant state channel so the validation step is structurally guaranteed to validate against the exact file list the agents reviewed. The callers to update are the action composition root in `apps/action` and the shared end-to-end review entry point in `packages/reviewer`, along with their tests.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `runReviewPipeline` no longer accepts a changed-file argument separate from the `ReviewContext`
- [ ] The graph state declares exactly one changed-file channel, sourced from the context
- [ ] Validation demonstrably filters against the context's list, with a regression test that passes agent findings through the pipeline and proves they survive — and that the two lists can no longer diverge
- [ ] The `apps/action` composition root, the `packages/reviewer` end-to-end entry point, and all existing tests that construct pipeline calls are updated to the new signature
- [ ] Typecheck and the full test suite pass, with no behaviour change for a correctly-wired review
