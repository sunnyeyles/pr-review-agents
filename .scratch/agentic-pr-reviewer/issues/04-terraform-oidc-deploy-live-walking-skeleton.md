# 04 — Terraform + OIDC deploy: live walking skeleton

**What to build:** Installing the GitHub App on a repo and opening a PR produces the stub "AI PR Review" check run on real AWS infrastructure. Terraform (state in S3) provisions API Gateway, both Lambdas, the SQS queue and its dead-letter queue, Secrets Manager entries for the Anthropic key, App private key, and webhook secret, CloudWatch log groups, and separate least-privilege IAM roles per Lambda (spec.md §23). A GitHub Actions workflow deploys on push to main using AWS OIDC — no long-lived AWS keys, and no secrets in git, Terraform files, Lambda bundles, or workflow files.

**Blocked by:** 03 — Worker skeleton (deploys both Lambda bundles; 02 transitively).

**Status:** in-review

- [ ] `terraform apply` from a clean state provisions the full stack with S3-backed state — not verified: this slice was write+validate only (no AWS calls); `terraform fmt -check` and `terraform validate` pass. Requires the one-time bootstrap in terraform/README.md (state bucket, OIDC provider, deploy role) before the first apply.
- [ ] Opening or updating a PR on a repo with the App installed produces the stub check run end-to-end — not verified: needs a live deploy plus GitHub App webhook URL/secret configuration (terraform/README.md steps 5–6).
- [ ] Repeatedly failing jobs land in the dead-letter queue — not verified live: redrive (maxReceiveCount 3) and the DLQ are provisioned; observation procedure documented in terraform/README.md.
- [x] Each Lambda has its own IAM role scoped to only the actions spec.md §23 lists (webhook: sqs:SendMessage + GetSecretValue on its one secret + logs; worker: SQS receive/delete + GetSecretValue on its two secrets + logs; every statement resource-scoped — sqs:GetQueueAttributes added on the worker as the SQS event source mapping requires it)
- [ ] Secrets are read from Secrets Manager at runtime and appear nowhere in source control or bundles — mechanism implemented (`@pr-review/config` resolveSecret via env-injected `<NAME>_SECRET_ARN`, unit-tested with the SDK stubbed; no secret values exist anywhere in the repo or bundles) but the live runtime fetch is not verified against AWS.
- [x] The deploy workflow authenticates via OIDC and runs typecheck → tests → build → terraform plan/apply (structure verified; `permissions: id-token: write`, role from repo variable, no long-lived keys or secrets in the file — not exercised against AWS)
