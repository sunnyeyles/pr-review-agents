# 10 — Structured observability

**What to build:** A single PR review is traceable end-to-end in CloudWatch: structured logs emit the lifecycle events from spec.md §26 — review received/queued/started, agent started/completed/failed per agent, synthesis started/completed, and review published/failed — carrying repository, PR number, commit SHA, agent name, duration, finding count, and token usage where each applies. An operator can answer "what happened to the review for PR N?" from logs alone: which agents ran, how long each took, how many findings survived, and what it cost in tokens.

**Blocked by:** 08 — Synthesiser (the last events to instrument exist from then on).

**Status:** ready-for-agent

- [ ] Every lifecycle event in spec.md §26 is emitted as structured JSON at the right point in the pipeline
- [ ] Events are correlatable: one review's events share identifying fields (repository, PR number, commit SHA)
- [ ] Agent events include duration and token usage; publish events include the final finding count
- [ ] A failed agent and a failed review each produce their failure event with enough context to diagnose
- [ ] Unit tests assert the key events fire on the success, partial-failure, and failure paths
