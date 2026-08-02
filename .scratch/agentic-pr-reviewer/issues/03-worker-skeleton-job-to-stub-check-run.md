# 03 — Worker skeleton: queued job → stub Check Run

**What to build:** The worker consumes a review job from SQS, authenticates as the GitHub App installation, loads the PR (title, description, changed files, diff), and publishes a Check Run named "AI PR Review" against the head SHA with placeholder content. This proves the whole pipeline shape — queue consumption, App auth, PR loading, check publishing — before any AI is involved. Demoable by invoking the worker handler locally with a hand-crafted SQS message against a real or recorded GitHub repo.

**Blocked by:** 02 — Webhook intake (consumes the review-job schema and queue contract).

**Status:** ready-for-agent

- [ ] Worker parses and Zod-validates the incoming review job, failing loudly on malformed messages so they can retry / dead-letter
- [ ] Worker authenticates as the GitHub App installation from the job's installation ID
- [ ] Worker loads the PR, its changed files, and its diff via read-only GitHub API calls
- [ ] A Check Run named "AI PR Review" is published against the job's head SHA with placeholder output
- [ ] Unit tests cover job parsing/validation and check-run publishing (GitHub API mocked)
