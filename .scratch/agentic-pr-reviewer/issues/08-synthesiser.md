# 08 — Synthesiser

**What to build:** The three agents' raw findings pass through a Synthesiser before deterministic validation: it removes duplicates across agents, drops weak or speculative findings, combines overlapping findings into one, corrects severity, and prioritises what remains — preferring a few strong findings over many speculative ones (spec.md §16). The Synthesiser is not the final authority: its output still flows through the full deterministic validation chain from ticket 05 before anything reaches GitHub. Demoable on a noisy PR: the check run shows fewer, sharper findings than the raw agent output.

**Blocked by:** 07 — Three agents concurrently + partial failure.

**Status:** ready-for-agent

- [ ] Two agents reporting the same underlying issue yield one combined finding, not two
- [ ] Weak/speculative findings present in raw agent output are absent from the final check run
- [ ] Synthesiser output is Zod-validated and then runs through the entire deterministic validation chain unchanged
- [ ] Synthesiser failure is handled: the review can still fall back to publishing validated raw findings rather than dropping the review
- [ ] Unit tests cover dedupe-across-agents, overlap merging, and weak-finding removal
