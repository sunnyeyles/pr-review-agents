# Evals

`pnpm eval` — real pipeline, real model, real token spend. Needs an API key;
`pnpm test` never calls a model.

## What is evaluated

Two fixtures, four assertions. Two of them are quality signals; two are health
checks that stop a crashed agent from reading as a quality result.

| Fixture | Assertion | Signal |
| --- | --- | --- |
| `security-tenant-scope` | every agent completes | health |
| `security-tenant-scope` | a `security` finding lands on `findCustomerById` or `getCustomer` | recall |
| `clean-pagination` | every agent completes | health |
| `clean-pagination` | zero findings | precision |

This is the floor. Drop either fixture and you lose recall or precision: a
reviewer that reports nothing passes the clean fixture, and one that reports
everything passes the security fixture. Only the pair constrains both.

Assertions match on category and location, never wording — see
`expectations.ts`. Anchors must match exactly one line of a changed file, so a
fixture edit that moves the planted bug fails loudly instead of silently
passing.

## Known gaps

- **`docs-drift` has no quality assertion.** `.github/pr-review-agents.yml`
  ships `security` and `docs-drift`; every assertion above targets `security`.
  `docs-drift` is only exercised as "did not crash, stayed quiet on clean code".
- **No correctness fixture.** `correctness-admin-check` was removed in `838d168`
  when the correctness agent stopped shipping. Recoverable from git history.

## Layout

```
cases.ts               the spec: fixtures and their expectations
expectations.ts        the judge: category + anchored location
fixture.ts             loads repo/ (head) and base/ into the pipeline's inputs
fixture-client.ts      GithubInstallationClient over a fixture; writes throw
unified-diff.ts        synthesises patches from the two trees
run-fixture-review.ts  drives the real pipeline; only client and publish differ
model-access.ts        credentials, and the fail-fast before any spend
```

## Adding a fixture

1. `fixtures/<name>/fixture.json` — the manifest, plus `repo/` (tree at head)
   and `base/` (previous contents of modified files only).
2. Add the case to `cases.ts` with `agentsCompleted` and its real expectation.

Anchor to a marker that appears once in the file.
