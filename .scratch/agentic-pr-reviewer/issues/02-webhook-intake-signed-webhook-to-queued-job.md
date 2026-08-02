# 02 — Webhook intake: signed webhook → queued review job

**What to build:** When GitHub sends a pull-request webhook (opened, updated, or reopened), the webhook handler verifies the signature, rejects anything unsigned or unsupported, extracts a review job (installation ID, owner, repo, PR number, head SHA), and enqueues it to SQS — returning immediately with no AI work. Invalid signatures and unsupported events are rejected without enqueueing. The review-job shape lives in the shared schemas package so the worker can consume it later. Demoable by invoking the handler locally with fixture payloads (SQS stubbed in tests).

The job shape from spec.md §5 (decision-rich, keep as-is):

```ts
type ReviewJob = {
  installationId: number;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
};
```

**Blocked by:** 01 — Monorepo scaffold with green CI.

**Status:** ready-for-agent

- [ ] A correctly signed PR opened/updated/reopened payload results in exactly one review job on the queue
- [ ] A payload with a bad or missing signature is rejected and nothing is enqueued
- [ ] Non-PR events and unsupported PR actions are acknowledged but not enqueued
- [ ] Unit tests cover signature verification (valid, invalid, missing) and event filtering
- [ ] The review-job schema is defined once in the shared schemas package and validated with Zod
