# Evals

`pnpm eval` — real pipeline, real model, real token spend. Needs an API key;
`pnpm test` never calls a model.

## What is evaluated

Two fixtures, six assertions. Three of them are quality signals; two are health
checks that stop a crashed agent from reading as a quality result.

| Fixture | Assertion | Signal |
| --- | --- | --- |
| `security-tenant-scope` | every agent completes | health |
| `security-tenant-scope` | a `security` finding lands on `findCustomerById` or `getCustomer` | recall |
| `security-tenant-scope` | every proposed patch matches the file at head | precision |
| `clean-pagination` | every agent completes | health |
| `clean-pagination` | zero findings | precision |
| `clean-pagination` | every proposed patch matches the file at head | precision |

`patches-verify` is precision only: proposing no patch passes it. What fails is
a patch whose quoted `expected` lines do not match the file, which is the one
thing about a fix a unit test cannot check — whether the model counted lines
correctly against a real tree.

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
- **No fixture requires a patch.** `patches-verify` catches a wrong patch but
  cannot notice a reviewer that never proposes one, so fix recall is unmeasured.
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
