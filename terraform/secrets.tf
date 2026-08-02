# Secrets Manager entries. Terraform creates the *containers only* —
# secret values are never present in source control, Terraform files,
# state, or Lambda bundles. Set values out-of-band after the first
# apply (see README.md):
#
#   aws secretsmanager put-secret-value --secret-id <name> --secret-string '...'
#
# The Lambdas receive each secret's ARN via a <NAME>_SECRET_ARN
# environment variable and fetch the value at runtime.

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name        = "${var.project}/anthropic-api-key"
  description = "Anthropic API key used by the review agents."
}

resource "aws_secretsmanager_secret" "github_app_private_key" {
  name        = "${var.project}/github-app-private-key"
  description = "PEM-encoded GitHub App private key used by the worker Lambda."
}

resource "aws_secretsmanager_secret" "github_webhook_secret" {
  name        = "${var.project}/github-webhook-secret"
  description = "GitHub webhook secret used to verify webhook signatures."
}
