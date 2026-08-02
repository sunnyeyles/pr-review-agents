# Infrastructure

Terraform for the agentic PR reviewer walking skeleton:

- API Gateway (HTTP API) → webhook Lambda (`POST /webhook`)
- SQS review queue + dead-letter queue (redrive after `max_receive_count` failed deliveries, default 3)
- Event source mapping queue → worker Lambda with `ReportBatchItemFailures`
- Secrets Manager secrets (containers only — values are set out-of-band, never by Terraform)
- CloudWatch log groups with retention
- Two separate least-privilege IAM execution roles (spec §23)

State lives in S3 (`backend "s3"`); the bucket is account-specific and supplied at init time.

## Runtime secrets strategy

The Lambdas read secrets from Secrets Manager at runtime using the AWS SDK
(not the Lambda secrets extension — one less layer to pin per region, and the
fetch happens once per cold start anyway):

1. Terraform injects each secret's ARN as a `<NAME>_SECRET_ARN` environment
   variable (e.g. `GITHUB_WEBHOOK_SECRET_SECRET_ARN`).
2. `@pr-review/config`'s `resolveSecret("<NAME>")` fetches the value via
   `secretsmanager:GetSecretValue` on first invocation and the entrypoint
   caches the built handler for the container's lifetime.
3. Locally and in tests, the plain `<NAME>` environment variable is used
   instead — no AWS access needed.

Secret values therefore never appear in git, Terraform files, Terraform
state, Lambda bundles, or workflow files.

## One-time bootstrap (manual, before the first deploy)

These steps are deliberately outside this Terraform configuration (they are
the trust anchor it depends on). Run them once with an admin credential.

### 1. Terraform state bucket

```sh
aws s3api create-bucket \
  --bucket <STATE_BUCKET> \
  --region <REGION> \
  --create-bucket-configuration LocationConstraint=<REGION>
aws s3api put-bucket-versioning \
  --bucket <STATE_BUCKET> \
  --versioning-configuration Status=Enabled
aws s3api put-public-access-block \
  --bucket <STATE_BUCKET> \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

State locking uses S3 native lockfiles (`use_lockfile = true`, Terraform >= 1.10);
no DynamoDB table is needed.

### 2. GitHub OIDC identity provider

One per AWS account (skip if it already exists):

```sh
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

### 3. Deploy role

Create the role GitHub Actions assumes. Trust policy — replace
`<ACCOUNT_ID>` and `<OWNER>/<REPO>`; the `sub` condition restricts the role
to pushes to `main` of this repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

```sh
aws iam create-role \
  --role-name pr-review-agents-deploy \
  --assume-role-policy-document file://trust-policy.json
```

Permissions: the role needs to manage exactly what this configuration
provisions — API Gateway v2, Lambda, SQS, Secrets Manager (create/describe/
tag, **not** `GetSecretValue`), CloudWatch Logs, IAM (scoped to the
`pr-review-*` roles/policies), plus read/write on the state bucket. For a
first bootstrap, attaching `PowerUserAccess` plus a scoped IAM statement
works; tighten to the list above once the stack is stable.

### 4. GitHub repository variables

Settings → Secrets and variables → Actions → **Variables** (these are all
non-secret identifiers; the workflow uses no repository secrets):

| Variable | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | ARN of the deploy role from step 3 |
| `AWS_REGION` | Deploy + state bucket region |
| `TF_STATE_BUCKET` | State bucket from step 1 |
| `TF_STATE_KEY` | e.g. `pr-review-agents/terraform.tfstate` |
| `PR_REVIEW_GITHUB_APP_ID` | Numeric GitHub App ID |

### 5. Secret values (after the first apply)

The first apply creates empty secret containers; put the values out-of-band:

```sh
aws secretsmanager put-secret-value \
  --secret-id pr-review/github-webhook-secret --secret-string '<value>'
aws secretsmanager put-secret-value \
  --secret-id pr-review/github-app-private-key --secret-string file://app-private-key.pem
aws secretsmanager put-secret-value \
  --secret-id pr-review/anthropic-api-key --secret-string '<value>'
```

### 6. Point the GitHub App at the stack

Set the App's webhook URL to the `webhook_endpoint` output and its webhook
secret to the value stored in step 5.

## Deploying

Pushes to `main` run `.github/workflows/deploy.yml`: typecheck → test →
build (`pnpm build`, esbuild bundles at `apps/*/dist/index.mjs`) →
`terraform plan` → `terraform apply`, authenticated via OIDC. Zips are
produced by the `archive_file` data source at plan time, so the build must
run before Terraform (the workflow orders this; do the same locally).

Manually:

```sh
pnpm install && pnpm build
cd terraform
cp backend.hcl.example backend.hcl   # fill in your values (gitignored)
terraform init -backend-config=backend.hcl
terraform plan -var aws_region=<REGION> -var github_app_id=<APP_ID>
terraform apply ...
```

Validate without touching any backend or AWS account:

```sh
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

## Verifying the dead-letter queue

A job that fails `var.max_receive_count` (default 3) deliveries moves to
`pr-review-review-dlq` — e.g. temporarily break the App private key secret
value, open a PR, and watch the DLQ's `ApproximateNumberOfMessagesVisible`.
Retries are spaced by the queue's visibility timeout (6× the worker
timeout), so expect the message to appear after roughly
`max_receive_count × visibility_timeout`.
