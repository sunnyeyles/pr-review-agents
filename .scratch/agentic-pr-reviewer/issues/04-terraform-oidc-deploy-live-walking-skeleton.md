# 04 — Terraform + OIDC deploy: live walking skeleton

**What to build:** Installing the GitHub App on a repo and opening a PR produces the stub "AI PR Review" check run on real AWS infrastructure. Terraform (state in S3) provisions API Gateway, both Lambdas, the SQS queue and its dead-letter queue, Secrets Manager entries for the Anthropic key, App private key, and webhook secret, CloudWatch log groups, and separate least-privilege IAM roles per Lambda (spec.md §23). A GitHub Actions workflow deploys on push to main using AWS OIDC — no long-lived AWS keys, and no secrets in git, Terraform files, Lambda bundles, or workflow files.

**Blocked by:** 03 — Worker skeleton (deploys both Lambda bundles; 02 transitively).

**Status:** ready-for-agent

- [ ] `terraform apply` from a clean state provisions the full stack with S3-backed state
- [ ] Opening or updating a PR on a repo with the App installed produces the stub check run end-to-end
- [ ] Repeatedly failing jobs land in the dead-letter queue
- [ ] Each Lambda has its own IAM role scoped to only the actions spec.md §23 lists
- [ ] Secrets are read from Secrets Manager at runtime and appear nowhere in source control or bundles
- [ ] The deploy workflow authenticates via OIDC and runs typecheck → tests → build → terraform plan/apply
