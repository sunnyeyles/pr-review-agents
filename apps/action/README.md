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
| `langfuse-public-key` | no | — | Langfuse public key. Set this and the secret key to manage prompts and collect traces. |
| `langfuse-secret-key` | no | — | Langfuse secret key. Store it as a secret. |
| `langfuse-base-url` | no | `https://cloud.langfuse.com` | Langfuse host, for self-hosted instances. |
| `langfuse-prompt-label` | no | `production` | Which labelled version of each prompt to fetch. |

## Langfuse (optional)

Leave the Langfuse inputs unset and the action runs on the system prompts built
into it, exporting nothing. That is the default and needs no account.

Supply **both** keys and two things change: the four system prompts
(`correctness_system`, `security_system`, `architecture_system`,
`synthesis_system`) are fetched from Langfuse at the start of the run, and the
agents, their tool calls, and the Synthesiser export traces.

Neither is load-bearing. If Langfuse is unreachable, slow, missing a prompt, or
returns text that has lost its output contract, that prompt falls back to the
built-in one and the review proceeds — per prompt, so one bad entry costs one
prompt rather than the run. Setting only one of the two keys disables both
features and logs `langfuse.disabled_incomplete_credentials`.

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
