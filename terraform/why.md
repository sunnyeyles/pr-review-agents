# Why these AWS services

This stack reviews pull requests. GitHub sends us a webhook when something happens on a PR. We verify it, put a job on a queue, and a worker runs AI agents that read the PR and leave review comments.

That workload has a few hard facts:

- Webhooks must get a fast `200` or GitHub retries and we look broken.
- A real review can take minutes (model calls + GitHub API), far longer than a webhook should wait.
- Traffic is bursty and mostly idle. We do not want to pay for always-on servers.
- We hold secrets (webhook HMAC, GitHub App private key, Anthropic API key). Those must never sit in git, Terraform state, or Lambda env vars as plaintext.
- Failed jobs must not disappear. We need retries and a place to inspect poison messages.

The services below exist because of those facts. Together they form a small, serverless pipeline:

```
GitHub → API Gateway → webhook Lambda → SQS → worker Lambda
                              ↓                      ↓
                       Secrets Manager         Secrets Manager
                              ↓                      ↓
                         CloudWatch Logs       CloudWatch Logs
```

---

## API Gateway (HTTP API)

**What it does:** Gives us a public HTTPS URL (`POST /webhook`) that GitHub can call.

**Why we use it:**

- GitHub needs a stable, internet-facing HTTPS endpoint. API Gateway is that front door without us running a load balancer or nginx.
- We use **HTTP API** (API Gateway v2), not REST API. For a single `POST` with Lambda proxy integration, HTTP API is cheaper, simpler, and fast enough. We do not need REST API features (API keys, usage plans, request/response mapping templates).
- Throttling on the stage (`burst` / `rate` limits) gives a basic shield against accidental or malicious floods without custom rate-limiting code.
- Lambda permission is scoped so only this API can invoke the webhook function.

**Why not alternatives:**

- **Function URL alone** works, but API Gateway gives us a named route, stage settings, and room to add more routes later without changing the GitHub App URL shape.
- **ALB + containers** is heavier for one POST handler that runs for milliseconds.
- **CloudFront** is for CDN/static content; it is not the right primary tool for authenticated webhook POSTs.

---

## Lambda (webhook and worker)

**What it does:** Runs our Node.js handlers on demand. Two functions, two jobs.

### Webhook Lambda

- Verifies the GitHub signature.
- Enqueues a review job.
- Returns quickly (timeout: 10 seconds).

GitHub expects a prompt acknowledgment. The webhook must not run the review. If it did, timeouts, duplicate deliveries, and concurrent reviews would become our problem on every PR event.

### Worker Lambda

- Pulls jobs from SQS.
- Runs the AI review agents (several model round trips + GitHub reads).
- Timeout: 300 seconds, more memory (512 MB), because this path is CPU- and I/O-heavy.

**Why Lambda fits this product:**

- **Idle most of the time.** PR events are sparse compared to a web app. Paying per invocation beats paying for EC2/ECS capacity that sits empty.
- **Scales with the queue.** When several PRs open at once, more worker invocations run. When quiet, scale is zero.
- **Natural split of concerns.** Fast edge work and slow AI work have different timeouts, memory, secrets, and IAM. Separate functions enforce that split.
- **arm64 + Node.js 22.** Graviton is usually cheaper for this kind of I/O-bound TypeScript. Our build already produces a single esbuild bundle; Lambda zip deploy matches that packaging model.
- **Event source mapping** from SQS to the worker is managed by AWS. We do not write a poller loop, manage concurrency knobs in our own process, or run a long-lived consumer.

**Why not alternatives:**

- **One Lambda for everything** would force the webhook path to wait on AI work, or force awkward async self-invokes. Two functions with a queue are clearer and safer.
- **ECS/Fargate always-on workers** make sense at high sustained load. We are not there yet; Lambda keeps ops and cost proportional to actual reviews.
- **Step Functions** could orchestrate multi-step reviews later. Today a single worker invocation is enough; adding Step Functions would buy visibility at the cost of more moving parts.

---

## SQS (review queue + dead-letter queue)

**What it does:** Holds review jobs between “webhook accepted” and “worker finished.” Failed jobs go to a DLQ after enough retries.

**Why a queue at all:**

- **Decouples acknowledgment from work.** The webhook can succeed even if the worker is cold, slow, or briefly failing.
- **Buffers bursts.** A flurry of PR events does not require every review to start in the same second as the webhook.
- **Retries with backoff via visibility timeout.** If the worker crashes or times out, the message becomes visible again and another attempt can run. We set visibility timeout to **6× the worker timeout**, which is the AWS-recommended pattern so an in-flight job is not redelivered while still running.
- **Batch size 1** matches the workload: each review is long and independent. `ReportBatchItemFailures` keeps correct per-message retry semantics if we ever raise the batch size.

**Why a dead-letter queue:**

- After `max_receive_count` failed deliveries (default 3), the message leaves the main queue. That stops endless retries on poison payloads (bad secret, unparseable body, permanent API error).
- DLQ retention (14 days) gives time to inspect, fix the cause, and redrive.
- Redrive allow policy locks the DLQ so only our review queue can send to it.

**Why SQS rather than other queues:**

- **SNS alone** is fan-out pub/sub, not a durable work queue with competing consumers and DLQ redrive.
- **Kinesis / EventBridge** are for streaming and event buses. We need a job queue with exactly-once-ish processing per message and simple Lambda integration.
- **DynamoDB streams / custom DB polling** would reinvent visibility timeouts, retries, and DLQs that SQS already provides.
- **SQS standard queue** is enough. We do not need FIFO ordering across PRs; reviews are independent. Standard is simpler and higher throughput.

---

## Secrets Manager

**What it does:** Stores secret *containers*. Terraform creates the names/ARNs only. Humans (or a separate secure process) put the values in after apply. Lambdas fetch values at runtime by ARN.

**Secrets we hold:**

| Secret | Who reads it | Why |
| --- | --- | --- |
| GitHub webhook secret | Webhook Lambda | HMAC verification of inbound webhooks |
| GitHub App private key | Worker Lambda | Authenticate as the GitHub App to comment on PRs |
| Anthropic API key | Worker Lambda | Call the model for reviews |

**Why Secrets Manager:**

- **Values never live in Terraform state.** Terraform manages the shell; `put-secret-value` is out-of-band. That is deliberate: state files, plans, and PRs must not contain the private key or API key.
- **Values never live in Lambda environment variables as plaintext.** Env vars hold ARNs only (`*_SECRET_ARN`). The SDK fetches the secret on cold start; the handler caches for the container lifetime.
- **Least privilege maps cleanly.** Webhook role can read only the webhook secret. Worker role can read only the App key and Anthropic key. Neither can read the other’s secrets.
- **Rotation path exists.** Even if we rotate manually today, the integration point is already “fetch by ARN,” so rotation does not require redeploying env var blobs.
- **Local/test escape hatch stays simple.** Outside AWS, plain env vars work; no Secrets Manager needed for unit tests.

**Why not alternatives:**

- **SSM Parameter Store (SecureString)** can work for simple secrets. Secrets Manager is the better fit when we care about a clear “secret object” lifecycle and may want rotation later. Cost difference is negligible at our scale (three secrets).
- **Hardcoding in env / GitHub Actions secrets injected at deploy** would put secret material into the Lambda configuration surface and often into CI logs or state. We avoid that.
- **Lambda secrets extension** is an extra layer to pin per region. A single SDK `GetSecretValue` per cold start is enough for this traffic pattern.

---

## CloudWatch Logs

**What it does:** Stores stdout/structured logs from both Lambdas, with an explicit retention period (default 30 days).

**Why we use it:**

- Lambda’s default logging destination is CloudWatch. Creating log groups in Terraform means **retention is enforced** from day one (otherwise groups can live forever and cost quietly grows).
- IAM can scope `logs:PutLogEvents` to **exactly these groups**, instead of a wildcard on all logs in the account.
- When a review fails or a webhook is rejected, the first place to look is the function’s log stream—no third-party agent required for the walking skeleton.

**Why not alternatives yet:**

- **OpenSearch / third-party APM** can come later if volume or search needs grow. For two functions and sparse traffic, CloudWatch Logs is the right default.
- Letting Lambda auto-create log groups would work functionally but loses retention control and tight IAM scoping.

---

## IAM (separate execution roles)

**What it does:** Each Lambda assumes its own role. Policies grant only the actions and resource ARNs that function needs.

**Webhook role:**

- `sqs:SendMessage` on the review queue
- `secretsmanager:GetSecretValue` on the webhook secret
- Write to its own log group

**Worker role:**

- `sqs:ReceiveMessage` / `DeleteMessage` / `GetQueueAttributes` on the review queue
- `secretsmanager:GetSecretValue` on the App private key and Anthropic key
- Write to its own log group

**Why this matters:**

- If the webhook function is ever compromised or buggy, it still cannot read the GitHub App private key or Anthropic key, and it cannot drain or delete queue messages.
- If the worker is compromised, it still cannot forge “accepted webhook” behavior via the webhook secret in a way that relies on that role (it does not have that secret).
- No shared “pr-review-lambda” role that accumulates permissions over time. New permissions must be justified per function.

This is not ceremony. For a bot that can comment on private repositories and spend API credits, least privilege is part of the product’s trust model.

---

## S3 (Terraform remote state)

**What it does:** Holds Terraform state. The bucket is created once by hand; Terraform uses it via the `s3` backend with native lockfiles (`use_lockfile = true`).

**Why:**

- State includes resource IDs and ARNs. It must be shared across CI and operators, versioned, and not kept only on one laptop.
- S3 versioning + public access block is the standard durable store for state.
- Native S3 lockfiles (Terraform ≥ 1.10) avoid a separate DynamoDB lock table for this project’s size.

**Why the bucket is outside this config:** State backend bootstrapping is a trust-anchor problem (chicken and egg). Creating the bucket manually once keeps this root module focused on the application stack.

---

## GitHub OIDC → IAM deploy role (bootstrap, not in this module)

**What it does:** GitHub Actions assumes an AWS role with short-lived credentials. No long-lived AWS access keys in the repository.

**Why:**

- Static access keys in GitHub Secrets are a common leak path. OIDC issues temporary credentials scoped to `repo:OWNER/REPO:ref:refs/heads/main`.
- The deploy role is allowed to manage this stack (and the state bucket), not the whole account forever—though the first bootstrap may start wider and then tighten.

This is not provisioned by the application Terraform on purpose: it is the credential that *applies* that Terraform.

---

## How the pieces answer the product constraints

| Constraint | Service that carries it |
| --- | --- |
| GitHub needs a public HTTPS webhook | API Gateway HTTP API |
| Acknowledge fast; review slowly | Webhook Lambda + SQS + worker Lambda |
| Bursty, mostly idle traffic | Lambda + SQS (scale to zero) |
| Do not lose or infinitely retry bad jobs | SQS retries + DLQ |
| Secrets never in git/state/env plaintext | Secrets Manager containers + runtime fetch |
| Blast radius if one function is wrong | Separate IAM roles, ARN-scoped policies |
| Debuggable without extra vendors | CloudWatch Logs with retention |
| Safe CI deploys | S3 state + GitHub OIDC assume-role |

---

## What we are deliberately not using (yet)

Keeping the skeleton small is a choice. These are reasonable later additions, not missing requirements for v1:

- **CloudWatch Alarms / SNS** on DLQ depth or Lambda errors — when we want pages, not just logs.
- **X-Ray or Langfuse-style tracing** — when we need end-to-end latency across model calls.
- **WAF** in front of the API — if the endpoint sees abuse beyond stage throttling.
- **FIFO queues or per-PR concurrency locks** — if duplicate in-flight reviews for the same PR become a real problem.
- **VPC** — only if we must reach private resources; today we call public GitHub and Anthropic APIs, and a VPC would add NAT cost without benefit.

---

## Bottom line

We are not using AWS services because “serverless is trendy.” We are using a thin set of primitives that match how GitHub webhooks and AI reviews actually behave: **accept quickly, work asynchronously, retry safely, keep secrets out of the pipeline, and pay only when a PR needs a review.**
