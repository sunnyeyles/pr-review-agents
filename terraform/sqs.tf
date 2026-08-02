# Review job queue between the webhook Lambda and the review (worker)
# Lambda, with a dead-letter queue for jobs that repeatedly fail.

resource "aws_sqs_queue" "review_dlq" {
  name = "${var.project}-review-dlq"

  # Keep failed jobs around long enough to inspect and redrive.
  message_retention_seconds = 14 * 24 * 60 * 60
}

resource "aws_sqs_queue" "review" {
  name = "${var.project}-review"

  # AWS recommends at least 6x the consuming function's timeout so
  # in-flight messages are not redelivered while a retry is running.
  visibility_timeout_seconds = 6 * local.worker_timeout_seconds

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.review_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "review_dlq" {
  queue_url = aws_sqs_queue.review_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.review.arn]
  })
}
