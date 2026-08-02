provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}

locals {
  webhook_function_name = "${var.project}-webhook"
  worker_function_name  = "${var.project}-worker"

  # Webhook only verifies a signature and enqueues; keep it snappy.
  webhook_timeout_seconds = 10

  # Worker loads the PR from GitHub and publishes the check run today;
  # headroom for the AI review agents landing in later tickets.
  worker_timeout_seconds = 60
}
