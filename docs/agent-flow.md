# Agent flow — what runs when

One pull request event in, one check run out. This document traces that path
in order, naming the file that owns each step.

The short version: **three agents propose, one synthesiser refines, and
deterministic code decides.** Only the last of those three ever reaches the
GitHub API.

---

## The whole pipeline

```mermaid
flowchart TD
    EVENT["pull_request event<br/><i>GITHUB_EVENT_PATH</i>"] --> ENTRY

    subgraph BOOT["1 · Boot — apps/action"]
        ENTRY["runEntrypoint / runAction<br/><code>index.ts</code>"]
        ENTRY --> LENS["resolveReviewLenses<br/><i>which agents run</i>"]
        LENS --> CLIENTS["build Anthropic + GitHub clients<br/>start tracing, fetch prompts"]
    end

    CLIENTS --> INSPECT["2 · inspectEvent<br/><code>event.ts</code>"]
    INSPECT -->|not a reviewable PR| NOOP["clean no-op<br/><i>step succeeds</i>"]
    INSPECT -->|reviewable| LOAD

    subgraph REVIEW["3 · One review — packages/reviewer"]
        LOAD["load PR, changed files, diff<br/><code>review-pull-request.ts</code>"]
    end

    LOAD --> GRAPH

    subgraph GRAPH["4 · LangGraph StateGraph — review-graph.ts"]
        direction TB
        START(["START"])
        START --> A1["agent__correctness"]
        START --> A2["agent__security"]
        START --> A3["agent__architecture"]
        A1 --> JOIN["join<br/><i>fan-in, agent order</i>"]
        A2 --> JOIN
        A3 --> JOIN
        JOIN --> SYNTH["synthesise<br/><i>one model call, no tools</i>"]
        SYNTH --> VAL["validate<br/><i>deterministic, 6 steps</i>"]
        VAL --> ENDN(["END"])
    end

    GRAPH --> RENDER["5 · renderCheckRun<br/><code>render-check-run.ts</code>"]
    RENDER --> PUB{"6 · publish"}
    PUB -->|checks: write| CHECK["AI PR Review check run<br/>+ inline annotations"]
    PUB -->|403 / 404 on a fork| SUM["workflow job summary<br/><code>summary.ts</code>"]

    style GRAPH fill:transparent
    style VAL stroke-width:3px
```

The one line to remember: **`validate` is the only node whose output the
caller may trust.** Everything upstream of it is untrusted model output.

---

## Stage by stage

### 1 · Boot — the Action entrypoint

`apps/action/src/index.ts`

`runEntrypoint()` runs at import time but returns immediately unless
`GITHUB_ACTIONS === "true"`, so importing the module in a test does no work.
`runAction` then resolves configuration in a deliberate order.

The lens selection happens *first*, before any client exists, because an
unrecognised agent name is a typo in a workflow file and must cost nothing to
discover:

```ts
// apps/action/src/index.ts:227
const lenses = resolveReviewLenses(getInput(env, "agents"));
```

`resolveReviewLenses` (`packages/ai/src/agents.ts:90`) throws on an unknown
name rather than dropping it — a silently ignored `agents: secuirty` would run
a review that reports nothing and looks exactly like a clean bill of health.

Then clients, tracing, and prompts, in that order: tracing starts before the
prompt fetch so the fetch's own spans are captured.

| Step | Function | Fails the run? |
| --- | --- | --- |
| Resolve lenses | `resolveReviewLenses` | Yes — unknown name |
| Anthropic client | `createAnthropicClient` | Yes — missing key |
| Langfuse tracing | `createLangfuseRuntime` | No — optional |
| Managed prompts | `loadManagedPrompts` | No — falls back per prompt |
| GitHub client | `createTokenClient` | Yes — missing token |

### 2 · Is this even a review?

`apps/action/src/event.ts` → `inspectEvent` (line 51)

Two outcomes, and the distinction matters:

- **Not a review** — wrong event name, or an action like `labeled`. Returns
  `{ review: false, reason }`, logs `review.skipped`, and the step *succeeds*.
  Most workflow triggers are not reviews.
- **Malformed** — claims to be a supported `pull_request` event but fails the
  schema. This *throws*: it is a bug worth failing the workflow over.

### 3 · Load the pull request

`packages/reviewer/src/review-pull-request.ts` → `reviewPullRequest` (line 139)

Three GitHub reads, concurrently — this is the only place the PR context is
built:

```ts
// packages/reviewer/src/review-pull-request.ts:154
const [pullRequest, changedFiles, diff] = await Promise.all([
  client.getPullRequest(ref),
  client.listChangedFiles(ref),
  client.getDiff(ref),
]);
```

`changedFiles` is the single source of truth for the rest of the run. The
agents see it, and `validate` filters against it — so validation can never
check findings against a different file list than the one the agents reviewed.

### 4 · The graph

`packages/reviewer/src/review-graph.ts` → `buildReviewGraph` (line 197)

Agent nodes are added dynamically, one per selected lens, each wired straight
from `START` so they run concurrently:

```ts
// packages/reviewer/src/review-graph.ts:197
const agentNodeNames = agents.map((agent, index) => {
  const nodeName = `agent__${agent.name}`;
  graph.addNode(nodeName, agentNode(index, agent));
  graph.addEdge(START, nodeName);
  return nodeName;
});

return graph
  .addNode("join", makeJoinNode(agents.length))
  .addEdge(agentNodeNames, "join")   // fan-in: waits for every agent
  .addNode("synthesise", makeSynthesiseNode(synthesiser))
  .addEdge("join", "synthesise")
  .addNode("validate", validateNode)
  .addEdge("synthesise", "validate")
  .addEdge("validate", END)
  .compile();
```

#### 4a · Each agent node

`packages/ai/src/agent-runtime.ts` → `createReviewAgent` (line 231)

All three lenses share one runtime. A `ReviewLens` supplies only the role,
focus text, and category; the loop, the six tools, the injection hardening,
and the output contract are identical by construction.

```ts
// packages/ai/src/agent-runtime.ts:365
for (let turn = 1; ; turn += 1) {
  const response = await callModel();
  const toolUses = toolUseBlocks(response.content);
  if (toolUses.length === 0) {
    finalText = textOf(response.content);   // this message is the answer
    break;
  }
  if (turn >= maxTurns) {
    throw turnCapExceeded;
  }
  messages.push({ role: "assistant", content: response.content });
  messages.push({ role: "user", content: await answerToolUses(toolUses) });
}
```

The cap (`DEFAULT_MAX_TURNS = 12`) bounds **model calls**, not tool round
trips. A response with no tool uses always ends the run on the call it arrived
on, so the cap can never burn a call the agent cannot answer.

After parsing, the runtime **filters** findings to the lens's own category.
Cross-category leaks are dropped, never re-stamped — re-stamping would
fabricate a claim the model never made.

**The six tools** (`packages/ai/src/tools.ts:148`) are the only tools any agent
ever gets. There is no write, comment, approve, merge, or execute tool
anywhere in the package:

| Tool | Reads |
| --- | --- |
| `get_pull_request` | Title, description, author, branches, SHAs |
| `list_changed_files` | The changed-file list |
| `get_diff` | The full unified diff |
| `get_file` | One file at the **head** SHA |
| `get_base_file` | One file at the **base** SHA |
| `search_repository` | Code search, scoped to this repo |

Every input is Zod-validated before it touches the GitHub client, and
`dispatchReviewTool` (line 277) **never throws** — failures come back as
`{ ok: false }` and are handed to the model as an error `tool_result` so the
loop keeps going.

#### 4b · `join` — fan-in

`makeJoinNode` (line 126). LangGraph only runs it once every incoming edge's
source has completed. It re-sorts outcomes by the agent's **input position**,
never completion order, so the result is deterministic. Then:

```ts
if (agentFailures.length === agentCount) {
  throw new Error(`every review agent failed — ${details}`);
}
```

One failed agent does not fail the review. All of them does.

#### 4c · `synthesise`

`makeSynthesiseNode` (line 159) → `createSynthesiser`
(`packages/reviewer/src/synthesiser.ts:113`)

**One** model call. No tools, no loop. It dedupes, merges overlaps, drops
speculation, corrects severity, and orders results most important first.

Three paths out:

| Path | Trigger | `synthesisOutcome` |
| --- | --- | --- |
| Skipped | Zero candidates — nothing to refine | `"skipped"` |
| Completed | Model returned valid JSON | `"completed"` |
| Failed | Bad output or API error → **raw candidates used** | `"failed"` |

A synthesis failure never fails the review. Its output is still untrusted
either way, because it flows through the same validation chain.

#### 4d · `validate` — the trust boundary

`packages/reviewer/src/validate-findings.ts:74`

Six deterministic steps, in this order:

1. **Schema validity** — Zod (`reviewFindingSchema`)
2. **File exists** among the PR's changed files
3. **Line is an added line** in that file's diff, when a line is given
4. **Confidence ≥ 0.7** (`CONFIDENCE_THRESHOLD`, line 30)
5. **Cap at 10** (`MAX_FINDINGS`, line 33), keeping the strongest
6. **Duplicate removal** — the strongest of each group survives

"Strongest" is fully deterministic: severity rank, then confidence descending,
then input order.

Note the ordering consequence: the cap runs *before* dedup, so a review can
publish fewer than 10 findings even when more valid candidates existed. That
is the spec's order, kept deliberately.

This is where a fabricated file path, an invented line number, or a padded
confidence score dies — regardless of how confident the model sounded.

### 5 · Render

`packages/reviewer/src/render-check-run.ts:112` — pure, no I/O.

| Situation | Conclusion |
| --- | --- |
| No findings, no agent failures | `success` — "No issues found" |
| Any findings | `neutral` — advisory; never blocks a merge |
| An agent failed, even with zero findings | `neutral` — an incomplete review must not publish a clean bill of health |

Line-anchored findings also become inline annotations (GitHub caps these at 50
per request).

### 6 · Publish

`apps/action/src/summary.ts:112` → `createFallbackPublisher`

Try the check run first. On a **403 or 404**, fall back to the workflow job
summary and exit cleanly — that is the fork case, where GitHub hands the
workflow a read-only token.

The check is on status alone, deliberately: matching GitHub's wording
("Resource not accessible by integration") would couple the fallback to text
that is not part of any API contract. Everything else — 401, 429, 5xx, or a
network error with no status at all — propagates and fails the step. None of
those may masquerade as a delivered review.

---

## Where things live

| Path | Owns |
| --- | --- |
| `apps/action/src/index.ts` | Inputs, client construction, wiring |
| `apps/action/src/event.ts` | Actions event parsing, ignore-quietly rule |
| `apps/action/src/handler.ts` | Event → review handoff |
| `apps/action/src/summary.ts` | Fork fallback to the job summary |
| `apps/action/src/langfuse.ts` | Span export for one run |
| `packages/reviewer/src/review-pull-request.ts` | One review, end to end |
| `packages/reviewer/src/review-graph.ts` | The StateGraph |
| `packages/reviewer/src/synthesiser.ts` | The single refining model call |
| `packages/reviewer/src/validate-findings.ts` | The trust boundary |
| `packages/reviewer/src/render-check-run.ts` | Findings → check run payload |
| `packages/ai/src/agents.ts` | The three lenses, lens selection |
| `packages/ai/src/agent-runtime.ts` | The shared agentic loop |
| `packages/ai/src/tools.ts` | The six read-only tools |
| `packages/ai/src/prompts.ts` | Managed prompts + fallback |
| `packages/schemas/src/review-finding.ts` | The finding contract |

## What fails the run, and what doesn't

| Event | Result |
| --- | --- |
| Unknown agent name | **Fails** before any model call |
| Missing API key or token | **Fails** |
| Unsupported event / ignored action | Clean no-op, step succeeds |
| Malformed `pull_request` payload | **Fails** |
| One or two agents fail | Review continues; names listed in the check run |
| **Every** agent fails | **Fails** — re-runnable from the Actions UI |
| Synthesis fails | Raw candidates published instead |
| A tool call fails | Reported to the model, loop continues |
| Langfuse unreachable | In-code prompts used; no traces |
| Check run forbidden (fork) | Job summary instead; step succeeds |

## Lifecycle log events

Every event of one review carries `repository`, `pullRequestNumber`, and
`headSha`, so an operator can answer "what happened to the review for PR N?"
from the logs alone.

```
review.started → review.loaded
  → agent.started ×N → agent.completed / agent.failed ×N
  → synthesis.started → synthesis.completed / synthesis.failed / synthesis.skipped
  → findings.validated
  → review.published / review.published.degraded
```

## Running it

```bash
pnpm test        # vitest run
pnpm typecheck   # pnpm -r typecheck
pnpm build       # bundles apps/action to dist/index.mjs
pnpm eval        # review-quality evals against fixture repos
```
