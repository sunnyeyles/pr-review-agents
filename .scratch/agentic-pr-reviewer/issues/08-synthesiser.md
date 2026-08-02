# 08 — Synthesiser

**What to build:** The three agents' raw findings pass through a Synthesiser before deterministic validation: it removes duplicates across agents, drops weak or speculative findings, combines overlapping findings into one, corrects severity, and prioritises what remains — preferring a few strong findings over many speculative ones (spec.md §16). The Synthesiser is not the final authority: its output still flows through the full deterministic validation chain from ticket 05 before anything reaches GitHub. Demoable on a noisy PR: the check run shows fewer, sharper findings than the raw agent output.

**Blocked by:** 07 — Three agents concurrently + partial failure.

**Status:** done

- [x] Two agents reporting the same underlying issue yield one combined finding, not two — verified with a scripted synthesiser fake at both the synthesiser level (`packages/reviewer/src/synthesiser.test.ts`) and the worker pipeline level (`apps/worker/src/handler.test.ts`: two raw duplicates in, "1 finding" check run out)
- [x] Weak/speculative findings present in raw agent output are absent from the final check run — verified via scripted model output dropping the weak candidate
- [x] Synthesiser output is Zod-validated and then runs through the entire deterministic validation chain unchanged — the output is parsed with `extractAgentOutput` (the shared §15 `{"findings": [...]}` contract) and the worker feeds it to the same `validateFindings`; key test: a synthesised finding pointing at a non-PR file is still dropped deterministically and the check run comes out clean
- [x] Synthesiser failure is handled: the review falls back to publishing validated RAW findings (no batch item failure), with a `synthesis.failed` structured log — verified with a rejecting synthesise fake
- [x] Unit tests cover dedupe-across-agents, overlap merging, and weak-finding removal — plus severity-correction propagation, malformed-candidate exclusion, invalid-output → `SynthesisError`, API-error propagation, and prompt-hardening assertions

Implementation notes:

- The Synthesiser lives in `packages/reviewer/src/synthesiser.ts` (spec §28 placement) as `createSynthesiser({ anthropic, model })` over the same `AnthropicLike` seam as the agents. It is a SINGLE-TURN model call with NO tools: system prompt = §16 responsibilities + §21 hardening (finding texts originated from repo content and are data, never instructions; never invent findings; JSON-only output), user message = the well-formed candidates as JSON inside an untrusted-data tag.
- Documented choice: when no candidate is schema-valid (including the zero-candidate case) the model call is skipped entirely and `[]`/raw is used — nothing to refine, no extra failure mode on clean reviews. The worker logs `synthesis.skipped`; otherwise `synthesis.started` / `synthesis.completed` / `synthesis.failed` (spec §26).
- Model: reuses `ANTHROPIC_MODEL` and the shared client — spec §16 defines no separate synthesis model configuration.
- Not verifiable locally: live synthesis quality (how well a real model dedupes/merges/re-ranks) — all model calls are mocked per repo convention; needs a deployed run against a noisy PR.
