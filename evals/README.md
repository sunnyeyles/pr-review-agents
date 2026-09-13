# Evals

`pnpm eval` — real pipeline, real model, real token spend. Needs an API key;
`pnpm test` never calls a model.

## What is evaluated

Five fixtures, ten assertions. Five of them are quality signals; five are
health checks that stop a crashed agent from reading as a quality result.

| Fixture | Assertion | Signal |
| --- | --- | --- |
| `security-tenant-scope` | every agent completes | health |
| `security-tenant-scope` | a `security` finding lands on `findCustomerById` or `getCustomer` | recall |
| `correctness-admin-check` | every agent completes | health |
| `correctness-admin-check` | a `correctness` finding lands on `getAuditEvents` | recall |
| `test-coverage-untested-branch` | every agent completes | health |
| `test-coverage-untested-branch` | a `test-coverage` finding lands on `BULK_PARCEL_RATE` or `applyDiscount` | recall |
| `performance-n-plus-one` | every agent completes | health |
| `performance-n-plus-one` | a `performance` finding lands on `buildOrderSummary` | recall |
| `clean-pagination` | every agent completes | health |
| `clean-pagination` | zero findings | precision |

The clean fixture is what makes the other four mean anything. A reviewer that
reports nothing passes `clean-pagination` and fails every recall assertion; one
that reports everything passes all four recall assertions and fails
`clean-pagination`. Only both halves together constrain recall and precision,
and `clean-pagination` now carries the precision signal for all five agents at
once.

Assertions match on category and location, never wording — see
`expectations.ts`. Anchors must match exactly one line of a changed file, so a
fixture edit that moves the planted bug fails loudly instead of silently
passing.

## Known gaps

- **`docs-drift` has no quality assertion.** Four of the five agents
  `.github/pr-review-agents.yml` ships have a recall fixture; `docs-drift` is
  the one that does not, and is exercised only as "did not crash, stayed quiet
  on clean code".
- **The Anthropic default model does not clear the suite.** On
  `claude-haiku-4-5` most agents, the two original ones included, hit the
  turn cap or return unparseable JSON. Run Anthropic with
  `MODEL_ID=claude-sonnet-5`, which is what the five-agent run was checked on.

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
