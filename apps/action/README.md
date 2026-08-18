# AI PR Review

Reviews pull requests with three independent AI agents — **Correctness**,
**Security**, and **Architecture** — and publishes the result as an
`AI PR Review` check run with inline annotations.

The agents never write to GitHub. They are given six read-only tools and
propose structured findings; deterministic code then decides what actually gets
published: every finding must pass a schema check, name a file in the pull
request, anchor to a line the pull request actually added, and clear a
confidence threshold. The review is advisory and never blocks a merge.

## Usage

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: read
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: sunnyeyles/pr-review-action@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

No checkout step is needed — the agents read the pull request through the
GitHub API, never from a working copy, and never execute the code they review.

## Inputs

| Input | Required | Default | Purpose |
| --- | --- | --- | --- |
| `anthropic-api-key` | yes | — | Key the agents and Synthesiser authenticate with. Store it as a secret. |
| `github-token` | no | `${{ github.token }}` | Token for the read-only tools and the check run. |
| `model` | no | `claude-sonnet-5` | Anthropic model id. |

## Permissions

| Permission | Why |
| --- | --- |
| `contents: read` | Read files at the head and base commits. |
| `pull-requests: read` | Read the pull request, its changed files, and its diff. |
| `checks: write` | Publish the check run and its inline annotations. |

**Fork pull requests.** GitHub gives workflows triggered by fork pull requests a
read-only token, so the check run cannot be created. The action detects this and
writes the same review to the workflow **job summary** instead, then exits
successfully. Findings still list their file and line; only inline annotations
are lost.

## What it does not do

No automatic fixing, no automatic merging or approval, no review history, no
persistent memory between runs, and no writes of any kind beyond the single
check run.
