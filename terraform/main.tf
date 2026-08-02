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

  # Worker runs the AI review agents: several model round trips plus
  # GitHub reads per job. The SQS visibility timeout scales with this.
  worker_timeout_seconds = 300
}
