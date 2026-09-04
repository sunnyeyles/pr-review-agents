# AI PR Review

Reviews pull requests with the AI agents *you* define, and publishes the
result as inline pull request review comments, alongside an `AI PR Review`
check run carrying the full summary.

This action ships no agents of its own. You declare them in
`.github/pr-review.yml` and the review runs exactly those — see
[Defining your agents](#defining-your-agents), which you need before the
first run.

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
  pull-requests: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: sunnyeyles/pr-review-action@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

No checkout step is needed. Everything — the pull request, the diff, and the
agent configuration — is read through the GitHub API, never from a working
copy, and the code under review is never executed.

## Defining your agents

Each agent is one **lens**: a name, a role, and a focus. Declare them in
`.github/pr-review.yml`. Nothing runs until you do — this action has no agents
of its own, so there is no default review to inherit and no fork to maintain.

```yaml
lenses:
  - category: correctness
    role: Correctness reviewer
    focus: |
      Review the pull request ONLY for correctness problems:
      - bugs and incorrect logic
      - missing validation
      - unhandled edge cases
      Do NOT report style or architectural opinions — those are out of scope
      for you and will be discarded.

  - category: performance
    role: Performance reviewer
    focus: |
      Review ONLY for performance problems: N+1 queries, unbounded result
      sets, work repeated in a loop that could be hoisted.
    # Optional: makes the agent retrieve repository context before claiming.
    contextGuidance: |
      Use get_file and search_repository to confirm a claim before making it.
```

Add an agent with a new entry; remove one by deleting its entry. `category`
must be a lowercase kebab-case slug and is the only finding category that
agent may report; `synthesis` and `all` are reserved. Order decides the order
findings reach the Synthesiser.

The rest of each prompt — the injection hardening, the tool guidance, the JSON
output contract — is shared, so a lens only ever states its own focus.

A missing file, a malformed one, or one declaring no agents fails the step
before any model call: a review with the wrong agents, or none, looks exactly
like a clean bill of health.

A working three-agent starting point lives in
[`.github/pr-review.yml`](https://github.com/sunnyeyles/pr-review-agents/blob/main/.github/pr-review.yml)
of this action's repository — copy it and edit.

## Inputs

| Input | Required | Default | Purpose |
| --- | --- | --- | --- |
| `anthropic-api-key` | yes | — | Key the agents and Synthesiser authenticate with. Store it as a secret. |
| `github-token` | no | `${{ github.token }}` | Token for the read-only tools, the review comments, and the check run. |
| `model` | no | `claude-sonnet-5` | Anthropic model id. |
| `agents` | no | `all` | Which of the configured agents run: `all`, or a comma-separated subset of their names. |
| `lens-config` | no | `.github/pr-review.yml` | Path to the YAML file defining this repository's agents, read from the pull request's base commit. The file itself is required — there is no built-in set, and a missing one fails the step. |
| `langfuse-public-key` | no | — | Langfuse public key. Set this and the secret key to manage prompts and collect traces. |
| `langfuse-secret-key` | no | — | Langfuse secret key. Store it as a secret. |
| `langfuse-base-url` | no | `https://cloud.langfuse.com` | Langfuse host, for self-hosted instances. |
| `langfuse-prompt-label` | no | `production` | Which labelled version of each prompt to fetch. |

## Langfuse (optional)

Leave the Langfuse inputs unset and the action runs on the system prompts built
into it, exporting nothing. That is the default and needs no account.

Supply **both** keys and two things change: the system prompts are fetched
from Langfuse at the start of the run, and the agents, their tool calls, and
the Synthesiser export traces. One prompt is fetched per selected agent,
named after it (`correctness_system`, `security_system`, …), plus
`synthesis_system`.

Neither is load-bearing. If Langfuse is unreachable, slow, missing a prompt, or
returns text that has lost its output contract, that prompt falls back to the
built-in one and the review proceeds — per prompt, so one bad entry costs one
prompt rather than the run. Setting only one of the two keys disables both
features and logs `langfuse.disabled_incomplete_credentials`.

## Permissions

| Permission | Why |
| --- | --- |
| `contents: read` | Read files at the head and base commits. |
| `pull-requests: write` | Read the pull request, its changed files, and its diff, and post the review comments. |
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
