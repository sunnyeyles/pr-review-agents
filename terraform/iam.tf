# Separate least-privilege execution roles, one per Lambda (spec §23).
# Every statement is scoped to a specific resource ARN — no wildcard
# resources, and no shared role between the two functions.

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- Webhook Lambda -------------------------------------------------
# spec §23: sqs:SendMessage, secretsmanager:GetSecretValue, CloudWatch
# logging.

resource "aws_iam_role" "webhook" {
  name               = "${var.project}-webhook"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "webhook" {
  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.webhook.arn}:*"]
  }
 
  statement {
    sid       = "EnqueueReviewJobs"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.review.arn]
  }

  statement {
    sid       = "ReadWebhookSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.github_webhook_secret.arn]
  }
}

resource "aws_iam_role_policy" "webhook" {
  name   = "${var.project}-webhook"
  role   = aws_iam_role.webhook.id
  policy = data.aws_iam_policy_document.webhook.json
}

# --- Review (worker) Lambda ------------------------------------------
# spec §23: SQS receive/delete, Secrets Manager read, CloudWatch
# logging. sqs:GetQueueAttributes is additionally required by the
# Lambda SQS event source mapping to poll the queue.

resource "aws_iam_role" "worker" {
  name               = "${var.project}-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }

  statement {
    sid = "ConsumeReviewJobs"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.review.arn]
  }

  statement {
    sid     = "ReadWorkerSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.github_app_private_key.arn,
      aws_secretsmanager_secret.anthropic_api_key.arn,
    ]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "${var.project}-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}
