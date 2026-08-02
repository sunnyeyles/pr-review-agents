output "webhook_endpoint" {
  description = "URL to configure as the GitHub App webhook URL."
  value       = "${aws_apigatewayv2_api.webhook.api_endpoint}/webhook"
}

output "review_queue_url" {
  description = "URL of the review job queue."
  value       = aws_sqs_queue.review.url
}

output "review_dlq_url" {
  description = "URL of the dead-letter queue for repeatedly failing jobs."
  value       = aws_sqs_queue.review_dlq.url
}

output "webhook_function_name" {
  description = "Name of the webhook Lambda."
  value       = aws_lambda_function.webhook.function_name
}

output "worker_function_name" {
  description = "Name of the review (worker) Lambda."
  value       = aws_lambda_function.worker.function_name
}

output "secret_arns" {
  description = "Secrets Manager ARNs whose values must be set out-of-band (never via Terraform)."
  value = {
    anthropic_api_key      = aws_secretsmanager_secret.anthropic_api_key.arn
    github_app_private_key = aws_secretsmanager_secret.github_app_private_key.arn
    github_webhook_secret  = aws_secretsmanager_secret.github_webhook_secret.arn
  }
}
