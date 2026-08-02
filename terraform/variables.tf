variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "pr-review"
}

variable "aws_region" {
  description = "AWS region to deploy into (no default to avoid accidental wrong-region deploys)."
  type        = string
}

variable "github_app_id" {
  description = "Numeric GitHub App ID (not a secret; the App private key lives in Secrets Manager)."
  type        = string
}

variable "anthropic_model" {
  description = "Anthropic model id the review agents use (worker env ANTHROPIC_MODEL; never hard-coded in the application)."
  type        = string
  default     = "claude-sonnet-5"
}

variable "log_retention_days" {
  description = "CloudWatch log retention for both Lambdas."
  type        = number
  default     = 30
}

variable "max_receive_count" {
  description = "Deliveries before a review job is moved to the dead-letter queue."
  type        = number
  default     = 3
}
