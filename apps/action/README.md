# Review Agent Fleet

Reviews pull requests with the AI agents *you* choose — the ones this
repository names in `.github/pr-review-agents.yml`, and no agent by default.
Findings post as inline pull request review comments, alongside a check run
named `AI PR Review` carrying the full summary. The model provider is
configurable.

This action ships two specialists and runs neither by default. You name
the ones you want in `.github/pr-review-agents.yml` and the review runs exactly
those — see [Choosing your agents](#choosing-your-agents), which you need
before the first run.

The agents never write to GitHub. They are given eight read-only tools and
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
          api-key: ${{ secrets.OPENAI_API_KEY }}
```

Moving from `v1`: the `anthropic-api-key` input is now `api-key`, and
`model-provider` selects OpenAI (the default) or Anthropic.

No checkout step is needed. Everything — the pull request, the diff, and the
agent configuration — is read through the GitHub API, never from a working
copy, and the code under review is never executed.

## Choosing your agents

Two specialists ship with this action:

| Name | Reviews for |
| --- | --- |
| `security` | Auth, cross-tenant access, injection, secret leakage, privilege |
| `docs-drift` | Documentation this change made wrong |

Name the ones you want in `.github/pr-review-agents.yml`. Nothing runs until
you do — there is no default review to inherit.

```yaml
agents:
  - security
  - docs-drift
```

Add an agent with a new name; remove one by deleting its line. An agent's name
is the only finding category it may report. Order decides the order findings
reach the Synthesiser.

Each agent's role and focus ship with the action, so this file selects and
tunes agents rather than defining them; the injection hardening, the tool
guidance, and the JSON output contract are shared across all of them.

A missing file, a malformed one, or one naming no agents fails the step
before any model call: a review with the wrong agents, or none, looks exactly
like a clean bill of health.

### Per-agent models

An agent can name its own model, written out under `agent:`; everything else,
the Synthesiser included, uses the `model` input. The provider and API key stay
the run's, so the model must be one that provider serves:

```yaml
agents:
  # Cheap: it only checks whether the docs still match the code.
  - agent: docs-drift
    model: gpt-5-mini

  # No `model`, so this runs on the action's default (`gpt-5.6-luna`).
  - security
```

### Path filters

An agent can declare the paths it cares about and sit out a pull request that
touches none of them:

```yaml
agents:
  - agent: security
    paths:
      - "packages/github/**"
      - "**/auth/**"
      - "!**/*.test.ts"

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

A working starting point lives in
[`.github/pr-review-agents.yml`](https://github.com/sunnyeyles/pr-review-agents/blob/main/.github/pr-review-agents.yml)
of this action's repository — copy it and edit.

## Inputs

| Input | Required | Default | Purpose |
| --- | --- | --- | --- |
| `api-key` | yes, as the input or through `env` | — | Key for the selected provider, which the agents and Synthesiser authenticate with. Store it as a secret. Falls back to that provider's own variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) when left empty. |
| `model-provider` | no | `openai` | Which provider to call: `openai` or `anthropic`. An unknown name fails the step before any model call. |
| `github-token` | no | `${{ github.token }}` | Token for the read-only tools, the review comments, and the check run. |
| `model` | no | the provider's own | Default model id, as the provider spells it: `gpt-5.6-luna` on `openai`, `claude-haiku-4-5` on `anthropic`. An agent may override it with its own `model`; the Synthesiser always uses this one. |
| `model-base-url` | no | the provider's own host | Overrides the provider's API host — a gateway, a proxy, or a compatible endpoint (for `openai`, one that accepts `max_completion_tokens`). |
| `agents` | no | `all` | Which of the configured agents run: `all`, or a comma-separated subset of their names. Naming a subset also overrides their `paths`. |
| `agent-config` | no | `.github/pr-review-agents.yml` | Path to the YAML file naming this repository's agents, read from the pull request's base commit. The file itself is required — nothing runs by default, and a missing one fails the step. |
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
          model-provider: anthropic
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-sonnet-5
```

`model-base-url` points the selected adapter somewhere else — an Azure
deployment, a gateway, or a self-hosted server speaking that provider's API.

Prompt caching is requested on `anthropic` only — it is the provider whose API
takes explicit cache breakpoints. On `openai` nothing is requested and
`cacheCreationInputTokens` / `cacheReadInputTokens` stay at zero, which is
expected rather than a fault.

## Langfuse (optional)

Leave the Langfuse inputs unset and the action runs on the system prompts built
into it, exporting nothing. That is the default and needs no account.

Supply **both** keys and two things change: the agent system prompts are
fetched from Langfuse at the start of the run, and the agents, their tool
calls, and the Synthesiser export traces. One prompt is fetched per selected
agent, named after it (`security_system`, `docs_drift_system`, …).

The Synthesiser's own prompt is never fetched. It names the exact categories
the run accepts, so a stored copy would go stale the moment the agent set
changed — it is always built from the agents in play.

Neither is load-bearing. If Langfuse is unreachable, slow, missing a prompt, or
returns text that has lost its output contract, that prompt falls back to the
built-in one and the review proceeds — per prompt, so one bad entry costs one
prompt rather than the run. Setting only one of the two keys disables both
features and logs `langfuse.disabled_incomplete_credentials`.

## Permissions

Every one of them degrades rather than fails, except the first.

| Permission | With it | Without it |
| --- | --- | --- |
| `contents: read` | Reads files at the head and base commits, and the agent configuration | The action cannot run |
| `pull-requests: write` | Findings post as inline review comments | The check run annotates the same lines instead, and logs `review.comments.degraded` |
| `checks: write` | Publishes the `AI PR Review` check run and its annotations | The whole review is written to the workflow job summary instead, and logs `review.published.degraded` |

**Fork pull requests.** GitHub gives a fork-triggered workflow a read-only
token, so both degradations fire at once and the review lands in the job
summary. The step still exits 0. Findings keep their file and line; only the
inline placement is lost.

## What it does not do

No automatic fixing, no automatic merging or approval, no review history, no
persistent memory between runs, and no writes of any kind beyond the single
check run.
