# Both Lambdas deploy the esbuild bundles produced by `pnpm build`
# (apps/*/dist/index.mjs). Zipping happens here via archive_file, so
# the build step only has to produce dist/ — CI runs `pnpm build`
# before `terraform plan`.

data "archive_file" "webhook" {
  type        = "zip"
  source_file = "${path.module}/../apps/webhook/dist/index.mjs"
  output_path = "${path.module}/../apps/webhook/dist/webhook.zip"
}

data "archive_file" "worker" {
  type        = "zip"
  source_file = "${path.module}/../apps/worker/dist/index.mjs"
  output_path = "${path.module}/../apps/worker/dist/worker.zip"
}

resource "aws_lambda_function" "webhook" {
  function_name = local.webhook_function_name
  role          = aws_iam_role.webhook.arn

  filename         = data.archive_file.webhook.output_path
  source_code_hash = data.archive_file.webhook.output_base64sha256

  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = local.webhook_timeout_seconds

  environment {
    variables = {
      REVIEW_QUEUE_URL                 = aws_sqs_queue.review.url
      GITHUB_WEBHOOK_SECRET_SECRET_ARN = aws_secretsmanager_secret.github_webhook_secret.arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.webhook,
    aws_iam_role_policy.webhook,
  ]
}

resource "aws_lambda_function" "worker" {
  function_name = local.worker_function_name
  role          = aws_iam_role.worker.arn

  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256

  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = local.worker_timeout_seconds

  environment {
    variables = {
      GITHUB_APP_ID                     = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN = aws_secretsmanager_secret.github_app_private_key.arn
      # Not read by the worker yet; wired now so the review agents
      # (later tickets) only need code changes, not infra changes.
      ANTHROPIC_API_KEY_SECRET_ARN = aws_secretsmanager_secret.anthropic_api_key.arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.worker,
    aws_iam_role_policy.worker,
  ]
}

resource "aws_lambda_event_source_mapping" "review" {
  event_source_arn = aws_sqs_queue.review.arn
  function_name    = aws_lambda_function.worker.arn

  # One review job per invocation: jobs are long-running and
  # independent. The handler still returns partial batch responses, so
  # ReportBatchItemFailures keeps retry/DLQ semantics per-message if
  # the batch size is ever raised.
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}
