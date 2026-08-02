# 03 — Worker skeleton: queued job → stub Check Run

**What to build:** The worker consumes a review job from SQS, authenticates as the GitHub App installation, loads the PR (title, description, changed files, diff), and publishes a Check Run named "AI PR Review" against the head SHA with placeholder content. This proves the whole pipeline shape — queue consumption, App auth, PR loading, check publishing — before any AI is involved. Demoable by invoking the worker handler locally with a hand-crafted SQS message against a real or recorded GitHub repo.

**Blocked by:** 02 — Webhook intake (consumes the review-job schema and queue contract).

**Status:** done

- [x] Worker parses and Zod-validates the incoming review job, failing loudly on malformed messages so they can retry / dead-letter (invalid records reported via SQS partial batch responses, `batchItemFailures`)
- [ ] Worker authenticates as the GitHub App installation from the job's installation ID — implemented with @octokit/auth-app and unit-tested via the injectable client factory; not verified against a live GitHub App installation (no credentials locally)
- [ ] Worker loads the PR, its changed files, and its diff via read-only GitHub API calls — implemented and unit-tested against structural Octokit stubs; not exercised against the real GitHub API
- [ ] A Check Run named "AI PR Review" is published against the job's head SHA with placeholder output — publishing path implemented and unit-tested with a mocked checks API; no real check run created locally
- [x] Unit tests cover job parsing/validation and check-run publishing (GitHub API mocked)
