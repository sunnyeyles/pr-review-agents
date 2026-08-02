# 05 — Findings pipeline: validated findings render in the Check Run

**What to build:** The check run stops being a stub: given a list of review findings (hard-coded samples for now — no AI yet), the worker runs them through the full deterministic validation chain and renders the survivors in the "AI PR Review" check run, with inline annotations on findings that reference a specific changed line. Validation enforces, in order: schema validity, file exists in the PR, line belongs to the diff, confidence ≥ 0.70, maximum 10 findings, and duplicate removal (spec.md §17). Only deterministic application code touches the GitHub API — this establishes the side-effect boundary the AI slices will sit behind.

The finding shape from spec.md §15 (decision-rich, keep as-is):

```ts
type ReviewFinding = {
  file: string;
  line?: number;
  category: "correctness" | "security" | "architecture";
  severity: "low" | "medium" | "high";
  title: string;
  explanation: string;
  suggestedFix?: string;
  confidence: number;
};
```

**Blocked by:** 03 — Worker skeleton. (Runs in parallel with 04.)

**Status:** ready-for-agent

- [ ] The finding schema lives in the shared schemas package and is Zod-validated
- [ ] Findings referencing files not in the PR, lines outside the diff, or confidence below 0.70 are dropped
- [ ] More than 10 surviving findings are truncated to the strongest 10; duplicates are removed
- [ ] Surviving findings render in the check run summary; line-anchored findings also appear as inline annotations
- [ ] Unit tests cover every validation rule, including the pass-through and empty-findings cases
