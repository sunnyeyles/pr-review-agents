# AI PR Review

Reviews pull requests with the AI agents *you* define, and publishes the
result as inline pull request review comments, alongside an `AI PR Review`
check run carrying the full summary.

This action ships no agents of its own. You declare them in
`.github/pr-review-agents.yml` and the review runs exactly those — see
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
      - uses: sunnyeyles/pr-review-action@v2
        with:
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Moving from `v1`: the `anthropic-api-key` input is now `api-key`, and
`model-provider` selects Anthropic (the default) or OpenAI.

No checkout step is needed. Everything — the pull request, the diff, and the
agent configuration — is read through the GitHub API, never from a working
copy, and the code under review is never executed.

## Defining your agents

Each agent is a name, a role, and a focus. Declare them in
`.github/pr-review-agents.yml`. Nothing runs until you do — this action has no agents
of its own, so there is no default review to inherit and no fork to maintain.

```yaml
agents:
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
output contract — is shared, so an agent only ever states its own focus.

A missing file, a malformed one, or one declaring no agents fails the step
before any model call: a review with the wrong agents, or none, looks exactly
like a clean bill of health.

### Path filters

An agent can declare the paths it cares about and sit out a pull request that
touches none of them:

```yaml
agents:
  - category: security
    role: Security reviewer
    focus: Review ONLY for security problems.
    paths:
      - "packages/github/**"
      - "**/auth/**"
      - "!**/*.test.ts"

  # A built-in gated the same way.
  - agent: docs-drift
    paths: ["docs/**", "README.md"]
```

Patterns are globs over each changed file's repository-relative path: `**`
crosses directories, `*` does not, dotfiles match, and `!` subtracts. An agent
declaring no `paths` runs on every pull request, as all of them do today.

This gates *whether* an agent runs, never *what* it reviews — a woken agent
still sees the whole pull request, because a security-relevant change is
routinely exploited through a file that does not look security-relevant.

Nothing is skipped quietly. Skipped agents are named in the check-run summary
and logged as `agent.skipped`; a pull request no agent matched gets a
`neutral` check run titled "No agent reviewed this pull request", listing every
agent, its patterns, and the changed files — never a green one. Naming agents
on the `agents` input overrides the gate.

A working three-agent starting point lives in
[`.github/pr-review-agents.yml`](https://github.com/sunnyeyles/pr-review-agents/blob/main/.github/pr-review-agents.yml)
of this action's repository — copy it and edit.

## Inputs

| Input | Required | Default | Purpose |
| --- | --- | --- | --- |
| `api-key` | yes, as the input or through `env` | — | Key for the selected provider, which the agents and Synthesiser authenticate with. Store it as a secret. Falls back to that provider's own variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) when left empty. |
| `model-provider` | no | `anthropic` | Which provider to call: `anthropic` or `openai`. An unknown name fails the step before any model call. |
| `github-token` | no | `${{ github.token }}` | Token for the read-only tools, the review comments, and the check run. |
| `model` | no | the provider's own | Model id, as the provider spells it: `claude-sonnet-5` on `anthropic`, `gpt-5` on `openai`. |
| `model-base-url` | no | the provider's own host | Overrides the provider's API host — a gateway, a proxy, or a compatible endpoint (for `openai`, one that accepts `max_completion_tokens`). |
| `agents` | no | `all` | Which of the configured agents run: `all`, or a comma-separated subset of their names. Naming a subset also overrides their `paths`. |
| `agent-config` | no | `.github/pr-review-agents.yml` | Path to the YAML file defining this repository's agents, read from the pull request's base commit. The file itself is required — there is no built-in set, and a missing one fails the step. |
| `langfuse-public-key` | no | — | Langfuse public key. Set this and the secret key to manage prompts and collect traces. |
| `langfuse-secret-key` | no | — | Langfuse secret key. Store it as a secret. |
| `langfuse-base-url` | no | `https://cloud.langfuse.com` | Langfuse host, for self-hosted instances. |
| `langfuse-prompt-label` | no | `production` | Which labelled version of each prompt to fetch. |

## Model providers

The action is provider-agnostic: `model-provider` picks the adapter, `api-key`
carries that provider's key, and `model` names the model as that provider
spells it.

```yaml
        with:
          model-provider: openai
          api-key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-5
```

`model-base-url` points the selected adapter somewhere else — an Azure
deployment, a gateway, or a self-hosted server speaking that provider's API.

Prompt caching is requested on every agent turn and honoured where the provider
supports it; the token counters report cache writes and reads separately, and a
provider that reports neither leaves them at zero.

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
