# pr-review-agents

Reviews pull requests with the AI agents *you* choose, and publishes the
result as inline pull request review comments, alongside an `AI PR Review`
check run carrying the full summary.

The agents ship with the action, in
[`packages/ai/src/agents/specialists/`](packages/ai/src/agents/specialists) —
Security and Docs drift. Neither runs by
default. A repository names the ones it wants in
[`.github/pr-review-agents.yml`](#choosing-your-agents), and a review runs
exactly those, in the order that file lists them; with no such file the step
fails rather than guessing. Any subset can be selected per run.

This repository's own [`.github/pr-review-agents.yml`](.github/pr-review-agents.yml) names
both and is a working starting point to copy — but it is configuration, not a
default.

The agents never touch GitHub. They propose structured findings; deterministic
application code decides what actually gets published.

A finding may carry a **patch**: a replacement for a range of lines, quoted
alongside the exact text it expects to replace. Deterministic code checks that
quote against the file at the head commit character for character before the
patch can go anywhere. With [`fix: true`](#fixes) the surviving patches are
committed to the pull request branch in one commit; otherwise — and whenever
the commit cannot be made — they arrive as one-click suggested changes on the
review comments. The agent still never writes anything itself.

---

## Delivery path

A GitHub Action, run in the repository's own Actions runner. There's no
separate infrastructure to stand up and no GitHub App to register — the
workflow's own token authenticates the reads and publishes the check run.

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  checks: write        # omit and reviews still land, in the job summary

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: sunnyeyles/pr-review-action@v2
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
```

Source lives in [`apps/action`](apps/action); `release-action.yml` publishes the
bundle to the public action repository. `v2` made the provider configurable and
renamed the `anthropic-api-key` input to `api-key`; a `v1` workflow needs that
one rename to move.

Three names for the same thing, deliberately: this source repo is
`pr-review-agents`, the published action repo is `pr-review-action` and is
listed on the Marketplace as **[Review Agent Fleet](https://github.com/marketplace/actions/review-agent-fleet)**
(the `name:` in `action.yml`), and the check run it writes is `AI PR Review`
(`CHECK_RUN_NAME` in `packages/github/src/client.ts`).

On a fork PR, `GITHUB_TOKEN` is read-only and can't create a check run — the
Action detects that permission error, degrades to writing the review into the
job summary instead, and still exits 0.

---

## How a review happens

```text
GitHub PR event (pull_request: opened/synchronize/reopened)
   │
   ▼
GitHub Action (apps/action)
   │
   ├── authenticate with the workflow token
   ├── load PR, changed files, diff
   │
   ▼
Review pipeline
   │
   ├─ agent__<agent 1>  ─┐
   ├─ agent__<agent 2>   ├─► join ─► synthesise ─► validate ─► END
   └─ agent__<agent n>  ─┘
                                                        │
                                                        ▼
                                GitHub Check Run + annotations
                                (or job summary, on a fork PR)
```

---

## The trust boundary

This is the core design constraint of the project: **model output is untrusted
data until deterministic code has validated it.**

```text
Agents ──► raw candidates (unknown[])
              │
              ▼
        Synthesiser (AI: dedupe, merge, re-rank)
              │
              ▼
   ┌──────────────────────────────────────┐
   │ validateFindings()  — no model here  │
   │  1. Zod schema                       │
   │  2. category is one of your agents   │
   │  3. file exists in the PR            │
   │  4. line is an ADDED line in the diff│
   │  5. confidence >= 0.70               │
   │  6. duplicate removal                │
   │  7. cap at 10, strongest first       │
   └──────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────┐
   │ verifyPatches()     — no model here  │
   │  1. file is read at the head commit  │
   │  2. `expected` matches those lines   │
   │     byte for byte, or the patch dies │
   │  3. range touches the diff           │
   │  4. no two patches overlap           │
   │  5. cap at 5 files / 200 lines       │
   └──────────────────────────────────────┘
              │
              ▼
        GitHub API (application code only)
```

Reinforcing rules:

- Agents are given **eight read-only tools** and nothing else:
  `get_pull_request`, `list_changed_files`, `get_diff`, `get_file`,
  `get_base_file`, `search_repository`, `find_importers`,
  `find_co_changed_files`. No write, comment, approve, merge, or execute tool
  exists. The last three read the repository's default branch, so an agent is
  told to treat their results as pointers to read with `get_file`, never as
  evidence.
- Every agent's system prompt carries the same non-negotiable **prompt-injection
  block**: repository contents (diffs, files, PR title/description, search
  results) are data, never instructions; tool results grant no permissions.
- An agent's findings are **filtered to its own category**, not re-stamped. A
  security finding leaking out of the docs-drift agent is dropped, so category
  provenance stays deterministic.
- The check run conclusion is `neutral` whenever findings exist — the app is
  advisory and never blocks a merge.
- A **patch never reaches a file on the agent's word**. The agent quotes the
  lines it means to replace; application code re-reads them at the head commit
  and discards the patch on any mismatch. The finding survives without it, so a
  miscounted line costs the fix, never the review.
- Fixes are **committed, never forced**. The branch tip must still be the commit
  the review read, and the ref update is a plain fast-forward — a push that
  landed mid-review wins the race, and the fixes become suggestions instead.

---

## Repository layout

```text
apps/
  action/     Event parsing → review pipeline → check run (or job summary)
packages/
  ai/         Provider selection (model.ts), prompts, agent
              configuration, and agents/: agent definition, runtime loop,
              read-only tools, synthesiser, specialists/ (the shipped agents)
  reviewer/   Review pipeline, validation chain, check-run rendering
  github/     GitHub client (workflow-token auth) + Octokit calls
  schemas/    Zod schemas: ReviewFinding, the review trigger contract
  logging/    Structured single-line JSON logger
evals/        Fixture repositories and the harness that runs the real
              pipeline against them without touching GitHub
docs/         index.html — the architecture walkthrough, published to
              Pages; claude/ — how the agent skills read this repo
              (.nojekyll beside it, so Pages serves the file as written)
scripts/      esbuild bundler for apps/action, its smoke test, and the
              Langfuse prompt seeder
```

### Concurrency

The review pipeline (`packages/reviewer/src/review-pipeline.ts`) runs every
selected agent → `join` → `synthesise` → `validate`. The agents are started
together with `Promise.all`, so they run concurrently. Inside one agent, the
tool-calling loop is one `generateText` call
(`packages/ai/src/agents/runtime.ts`), capped at 12 steps.

### Partial failure

One failed agent does not fail the review. `join` collects outcomes in the
agents' original order (never completion order) and publishes what succeeded.
Only when *every* agent fails does the pipeline throw — which
fails the workflow step, so the run can be retried from the Actions UI.

Synthesis failure is softer still: it falls back to the raw candidates and
reports `synthesis.outcome: "failed"` on the result rather than failing the
review.

---

## Configuration

Set as `with:` inputs on the Action step ([`apps/action/action.yml`](apps/action/action.yml)):

| Input | Required | Purpose |
| --- | --- | --- |
| `api-key` | yes, as the input or through `env` | Key for the selected provider, which the agents and synthesiser authenticate with. Store as a repository or organisation secret; never inline it. Falls back to the provider's own variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) when left empty, so a workflow can pass keys through `env` instead of choosing one in YAML. |
| `model-provider` | no (default `openai`) | Which provider the agents and synthesiser call: `openai` or `anthropic`. An unknown name fails the step before any model call. |
| `github-token` | no (default `${{ github.token }}`) | Token for the eight read-only repository tools and for publishing the check run. |
| `model` | no (default: the provider's own — `gpt-5.6-luna`, `claude-haiku-4-5`) | Default model id, as the provider spells it. An agent may [override it](#per-agent-models); the synthesiser always uses this one. |
| `model-base-url` | no (default: the provider's own host) | Overrides the provider's API host — a gateway, a proxy, or a compatible endpoint (for `openai`, one that accepts `max_completion_tokens`). |
| `agents` | no (default `all`) | Which of the configured agents run: `all`, or a comma-separated subset of their names. Naming a subset also overrides any [path filters](#path-filters). |
| `agent-config` | no (default `.github/pr-review-agents.yml`) | Path to the YAML file naming the agents. Required — nothing runs until a repository names it. |
| `fix` | no (default `false`) | Whether verified [fixes](#fixes) are committed to the pull request branch. `true` turns it on; any other value leaves it off. Needs `contents: write`. |
| `langfuse-public-key` | no | Supply this and the secret key to fetch the agent system prompts from [Langfuse](#seeding-the-managed-prompts) and export traces there. Both unset is the default, and runs on the in-code prompts. |
| `langfuse-secret-key` | no | The other half. Setting only one of the two disables both features and logs `langfuse.disabled_incomplete_credentials`. |
| `langfuse-base-url` | no (default `https://cloud.langfuse.com`) | Langfuse host, for a self-hosted or regional instance. Keys are region-scoped: the wrong host 401s and drops every trace. |
| `langfuse-prompt-label` | no (default `production`) | Which labelled version of each prompt to fetch — try a prompt change on one repository before promoting it. |

### Model providers

Models are reached through the [AI SDK](https://ai-sdk.dev). Which providers
are allowed, what each one's default model is, and which environment variable
carries its key live in `packages/ai/src/model.ts`, selected by
`model-provider`:

```yaml
        with:
          model-provider: anthropic
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-sonnet-5
```

`model-base-url` points a provider at a gateway, a proxy, or any endpoint
speaking its API — OpenAI is bound to Chat Completions rather than the
Responses API for that reason. Adding a provider is an entry in `PROVIDERS`
and nothing else.

Prompt caching is requested on `anthropic` only — it is the provider whose API
takes explicit cache breakpoints (`packages/ai/src/agents/runtime.ts`). On the
default provider, `openai`, nothing is requested and the two cache counters stay
at zero; that is expected, not a regression.

### Choosing your agents

Two specialists ship with the action, one file each in
[`packages/ai/src/agents/specialists/`](packages/ai/src/agents/specialists):

| Name | Reviews for |
| --- | --- |
| `security` | Auth, cross-tenant access, injection, secret leakage, privilege |
| `docs-drift` | Documentation this change made wrong |

A repository names the ones it wants in `.github/pr-review-agents.yml` (or
wherever `agent-config` points):

```yaml
agents:
  - security
  - docs-drift
```

Adding an agent is a new name; removing one is deleting its line. Everything
downstream follows from the set — the prompt each agent is given, its Langfuse
prompt key, the categories the synthesiser is told about, the categories
validation accepts, and the labels findings are rendered under.

- An agent's name is also the finding category it owns, and the only category
  its findings may carry — findings in any other are discarded.
- The role and focus live in the specialist's own file and are dropped into
  the shared system prompt (`packages/ai/src/agents/definition.ts`); the
  security hardening, the tool guidance, and the JSON output contract come
  with it.
- Order is significant: it is the order findings reach the synthesiser.

Configuration selects and tunes agents; it does not define them. A new
specialist is a new file under `specialists/` and an entry in its `index.ts`,
which keeps the reviewers' prompts under code review like the rest of the
action.

### Per-agent models

An agent can name the model it runs on, written out under `agent:`. Anything
else uses the action's `model` input, and so does the synthesiser:

```yaml
agents:
  # Cheap: it only checks whether the docs still match the code.
  - agent: docs-drift
    model: gpt-5-mini

  # No `model`, so this runs on the action's default (`gpt-5.6-luna`).
  - security
```

The provider, the API key, and `model-base-url` are the run's, so every agent
model must be one the selected provider serves. Nothing reads a repository
variable on its own — this repo's `self-review.yml` passes
`model: ${{ vars.REVIEW_MODEL }}` explicitly, and a consumer workflow wanting
the same swap-without-a-commit has to wire the same line.

### Path filters

An agent can declare the paths it cares about, and sit out a pull request
that touches none of them:

```yaml
agents:
  - agent: security
    paths:
      - "packages/github/**"
      - "**/auth/**"
      - "!**/*.test.ts"

  - agent: docs-drift
    paths: ["docs/**", "README.md"]

  # No `paths`, so it runs on everything, as every agent does today.
  - security
```

Patterns are globs matched against each changed file's repository-relative
path: `**` crosses directories, `*` does not, dotfiles match (so `.github/**`
reads the way it is written), and a `!` prefix subtracts from what the
positive patterns matched. A list of nothing but negations, an empty list, or
a pattern that is not repository-relative fails the step at config-parse time
— each would retire the agent without a word.

**This is a gate, not a narrowing.** An agent one changed file wakes reviews
the *whole* pull request, on the same diff and the same prompt as always. Two
reasons: a security-relevant change is routinely exploited through a file that
does not look security-relevant, and handing each agent its own filtered diff
would break the prompt-cache prefix the agents share, costing more than the
skips save.

Skipping is never silent:

| Situation | Result |
| --- | --- |
| Some agents skipped, others found nothing | `success` — the summary names each skipped agent and the patterns it waited for |
| Some agents skipped, others found something | `neutral`, as any review with findings is |
| **No agent matched at all** | `neutral`, titled "No agent reviewed this pull request", listing every agent, its patterns, and the changed files. Never `success` — a green check on a pull request nothing read is indistinguishable from a clean one |

Every skip is also logged as `agent.skipped` with the agent and its patterns,
and a review that never ran logs `review.no_agents_matched`.

Naming agents on the `agents` input overrides the gate: `agents: security`
runs Security whatever the pull request touched, because that input exists so
a person can force a specific review. `all`, or leaving it unset, leaves the
configured filters deciding.

The action reads the file from the pull request's **base** commit over the
API, so no `actions/checkout` step is needed — and, more to the point, a pull
request cannot choose the agents that review it. A head-ref read would let the
branch under review drop an agent, or gate every one of them away with
`paths`.

A missing file, a malformed one, or one that names no agents fails the step
before any model call — a review with the wrong agents, or none, looks exactly
like a clean bill of health, so it must never happen quietly.

`pnpm seed-prompts` reads the same file (`--config` to point elsewhere), so
the prompts published to Langfuse always match the agents configured.

### What a review costs

A model API is stateless, so every turn resends the whole conversation —
tools, system prompt, the opening message with the diff, and every tool result
so far. A ten-turn agent bills its opening message ten times. One measured run
of this repository's own PR #11, before caching, spent ~1.58M input tokens
across the three agents it ran at the time:

| Agent | Model calls | Input tokens |
| --- | --- | --- |
| Architecture | 10 | ~805k |
| Correctness | 9 | ~594k |
| Security | 4 | ~185k |

Architecture and Correctness were dropped after that run; only `security` and
`docs-drift` ship today. The shape of the number is what carries over, not the
row.

An agent declaring `contextGuidance` costs the most, because it must retrieve
surrounding repository context before it may make a claim, and every retrieval
is another round trip carrying the whole conversation. Of the shipped pair,
that is `docs-drift`.

Prompt caching reprices that traffic rather than reducing it: roughly 0.1x for
a cache read against 1.25x for the write that put it there. Each agent turn asks
for two things to be cached, both via `providerOptions.anthropic.cacheControl`:
the system instructions, through a breakpoint on that message, which also
covers the tool schemas; and the growing conversation tail, through a
call-level breakpoint that Anthropic places on the request's last block. So
turn two reads turn one's opening message and tool results from cache rather
than paying for them again. The synthesiser's single call is not cached; there
is no next turn to read it.

A cache that stops hitting raises the bill and changes nothing else, so the
three input counters are reported separately on `agent.completed` and
`synthesis.completed`, which is where a `pnpm eval` run shows them. On a
warmed-up review `cacheReadInputTokens` should dominate `inputTokens`; if it
collapses to zero, something above a breakpoint started varying between turns.

### Selecting agents

Each agent is an independent tool-calling loop, so a review costs essentially
the sum of its agents, and narrowing the set cuts that roughly in proportion:

```yaml
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          agents: security        # or: security,docs-drift
```

An unrecognised name fails the step **before any model call**, rather than
quietly running a narrower review whose empty result is indistinguishable from
a clean one. Synthesis still runs for a single agent, deliberately: a narrowed
run must exercise the same path a full review does, or it is useless for
iterating on a prompt.

Nothing is read from a secrets store at runtime — the workflow token and the
`api-key` input are the only credentials involved, and neither ever needs to be
provisioned outside GitHub's own secret settings.

### Fixes

Off by default. Turning it on lets one review commit its verified patches:

```yaml
permissions:
  contents: write        # only needed for fix: true
  pull-requests: write
  checks: write

# ...
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          fix: "true"
```

What is committed is never what an agent said, only what deterministic code
could prove: every patch quotes the lines it replaces, and a quote that does
not match the file at the head commit character for character is discarded
while its finding is still published. At most 5 files and 200 lines change per
review, and the commit is a plain fast-forward on the branch tip the review
read — a push that landed during the review wins.

Leaving `fix` off loses nothing. The same verified patches are rendered as
GitHub suggested changes on the review comments, which apply in one click; that
is also what happens on a fork, whose token cannot write, or when the branch
moved. The review body always says which of the two happened.

This repository has not turned it on for itself.
[`.github/workflows/self-review.yml`](.github/workflows/self-review.yml) still
grants `contents: read` and omits `fix`, so its own reviews propose fixes as
suggested changes and commit nothing. Enabling it is two lines, and is a
deliberate decision rather than the state this repository ships in.

The commit is authored by `github-actions[bot]` and carries a marker line. A
push made with `GITHUB_TOKEN` does not trigger workflows, so the review does not
re-run itself; if you swap in a PAT that does, the marker is the second guard —
a run whose head commit is one of ours reviews as normal but fixes nothing.

### Token permissions

Every one of them degrades rather than fails, except the first. Write access to
file contents is requested only for `fix: true`; merges and approvals never.

| Permission | With it | Without it |
| --- | --- | --- |
| `contents: read` | Reads files at the head and base commits, and the agent configuration | The action cannot run |
| `pull-requests: write` | Findings post as inline review comments | The check run annotates the same lines instead, and logs `review.comments.degraded` |
| `checks: write` | Publishes the `AI PR Review` check run and its annotations | The whole review is written to the workflow job summary instead, and logs `review.published.degraded` |
| `contents: write` | Commits verified fixes to the pull request branch, when `fix: true` | The same fixes are offered as suggested changes, and it logs `review.fixes.degraded` |

A fork-triggered workflow gets a read-only token, so both degradations fire at
once and the review lands in the job summary. The step still exits 0.

---

## Local development

Requires Node.js `>=22 <26` and pnpm `>=10`.

```sh
pnpm install
pnpm typecheck        # tsc --noEmit across every workspace package
pnpm test             # vitest run — the full Vitest suite
pnpm build            # esbuild → apps/action/dist/index.mjs (Node 24, ESM)
```

Workspace packages are consumed as TypeScript source and compiled into a
single self-contained bundle by `scripts/build-bundle.mjs` — nothing is left
external, since the Actions runner provides nothing beyond the Node runtime
itself.

Put local secret values in `.env.local` (gitignored) when exercising the
handler outside Actions. `scripts/seed-prompts.mjs` reads it; nothing else
does.

### Seeding the managed prompts

One agent prompt is editable in Langfuse per configured agent, but a project
only serves them once it holds them — until then every review falls back to the
in-code prompts and reports `loadedCount: 0`. The synthesiser's prompt is not
among them: it names the run's exact categories and is always built from the
agent set. Publish this build's prompts with:

```sh
pnpm seed-prompts -- --dry-run           # decide everything, write nothing
pnpm seed-prompts -- --label staging     # try a label before promoting
pnpm seed-prompts                        # publish to `production`
```

It needs `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (plus
`LANGFUSE_BASE_URL` when self-hosting or on a regional host), from the
environment or `.env.local`.

Re-running is a no-op when the labelled version already matches, so it never
piles identical versions onto a current project. A prompt that has been edited
in Langfuse keeps serving reviews — that is the point of managing them there —
and is superseded, not erased, the next time the seeder runs. A prompt that
would fail the contract guard in `packages/ai/src/prompts.ts` is never
published, since installing one would mean every review silently falling back
from it.

---

## Testing

Every seam that decides what reaches GitHub is covered by unit tests: event
parsing, the agent loop and its tool dispatch, the diff line index, the
validation chain, duplicate removal, partial-agent-failure semantics,
synthesis fallback, check-run rendering, and the fork-PR job-summary fallback.
The model client and Octokit are both injected behind narrow interfaces, so the
suite makes no network calls and runs in under two seconds.

```sh
pnpm test
```

---

## Publishing the Action

`.github/workflows/release-action.yml` runs on a `v*` tag (or manual dispatch):
install → typecheck → test → build the bundle → push only `action.yml`,
`dist/index.mjs`, `LICENSE`, and a usage `README.md` to a separate public repo,
moving that repo's major-version alias (`v2`) to the new tag and cutting a
GitHub Release there. Listing the Action on the Marketplace is a manual tick on
that release, once, and the listing is keyed on the `name:` in `action.yml` —
change it and the Marketplace URL moves with it. The engine, the tests, the
spec, and this README stay in this repo, and are not published downstream.
`.github/workflows/ci.yml` runs typecheck and tests on every push;
`.github/workflows/self-review.yml` dogfoods the Action on this repo's own
PRs, but only on a pull request labelled `ai-review` — reviews cost tokens, so
they are opt-in. Add the label to review, remove it to stop.

Required repository configuration for the release workflow:

| Setting | Purpose |
| --- | --- |
| `vars.ACTION_RELEASE_REPO` | Target public repo, e.g. `sunnyeyles/pr-review-action` |
| `secrets.ACTION_RELEASE_TOKEN` | Token with `contents: write` on that repo |

---

## Observability

Structured single-line JSON logs land in the workflow run's own log stream,
under event names, grouped by what they trace:

| Stage | Events |
| --- | --- |
| Review | `review.skipped`, `review.started`, `review.model_selected`, `review.agents_selected`, `review.loaded`, `review.no_agents_matched`, `review.failed` |
| Agents | `agent.started`, `agent.completed`, `agent.failed`, `agent.skipped` |
| Synthesis | `synthesis.started`, `synthesis.skipped`, `synthesis.completed`, `synthesis.failed` |
| Publishing | `findings.validated`, `review.comments.published`, `review.comments.degraded`, `review.comments.list_failed`, `review.published`, `review.published.degraded` |
| Langfuse | `langfuse.disabled_incomplete_credentials`, `langfuse.prompts.loaded`, `langfuse.prompts.unavailable`, `langfuse.prompts.fallback_used`, `tracing.flush_failed` |

That is every event a review run can emit. `pnpm seed-prompts` emits its own
`langfuse.prompts.seed_*` set, which no review ever writes.

Events carry the repository, PR
number, head SHA, agent name, duration, finding count, and token usage (four
counters: `inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`,
`outputTokens`), so a single review is greppable end to end by `headSha`.

---

## Further reading

- **[Propose, Refine, Decide](https://sunnyeyles.github.io/pr-review-agents/)**
  — the pipeline traced stage by stage, with a diagram, the file that owns each
  step, and the failure modes. Source: [`docs/index.html`](docs/index.html).

## Out of scope

By design there is no database, review history, dashboard, automatic fixing,
automatic merging or approval, vector database, repository embeddings, or
persistent agent memory.
