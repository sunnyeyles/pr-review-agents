# Log groups are created explicitly (rather than letting Lambda create
# them) so retention is enforced and the IAM policies can be scoped to
# exactly these groups.

resource "aws_cloudwatch_log_group" "webhook" {
  name              = "/aws/lambda/${local.webhook_function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.worker_function_name}"
  retention_in_days = var.log_retention_days
}
