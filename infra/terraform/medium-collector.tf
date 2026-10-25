# The Medium trend radar's collector: EventBridge Scheduler -> Lambda -> S3 (medium/*). See docs/medium.md.
# The Lambda's code is ../medium-collector/index.mjs: change that file and run terraform apply to update it.

# tradereye reads medium/* with the app user's existing access to the whole bucket (app-user.tf): nothing extra needed.

locals {
  collector_name = "tradereye-medium-collector"
  medium_objects = "arn:aws:s3:::${var.bucket}/medium/*"
}

data "archive_file" "medium_collector" {
  type        = "zip"
  source_file = "${path.module}/../medium-collector/index.mjs"
  output_path = "${path.module}/.build/medium-collector.zip"
}

# --- the Lambda's role: write its logs, read/write medium/* in the bucket, nothing else ---
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "medium_collector" {
  name               = local.collector_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "medium_collector_logs" {
  role       = aws_iam_role.medium_collector.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "medium_collector_s3" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = [local.medium_objects]
  }
}

resource "aws_iam_role_policy" "medium_collector_s3" {
  name   = "medium-collector-s3"
  role   = aws_iam_role.medium_collector.id
  policy = data.aws_iam_policy_document.medium_collector_s3.json
}

# --- the Lambda ---
resource "aws_cloudwatch_log_group" "medium_collector" {
  name              = "/aws/lambda/${local.collector_name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "medium_collector" {
  function_name    = local.collector_name
  description      = "Medium trend radar: reads Medium RSS feeds, saves to S3 medium/*"
  role             = aws_iam_role.medium_collector.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.medium_collector.output_path
  source_code_hash = data.archive_file.medium_collector.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = { BUCKET = var.bucket }
  }

  depends_on = [aws_cloudwatch_log_group.medium_collector, aws_iam_role_policy_attachment.medium_collector_logs]
}

# --- the schedule and the role that lets it run the Lambda ---
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "medium_collector_scheduler" {
  name               = "${local.collector_name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "invoke_collector" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.medium_collector.arn]
  }
}

resource "aws_iam_role_policy" "medium_collector_scheduler" {
  name   = "invoke-medium-collector"
  role   = aws_iam_role.medium_collector_scheduler.id
  policy = data.aws_iam_policy_document.invoke_collector.json
}

resource "aws_scheduler_schedule" "medium_collector" {
  name                         = local.collector_name
  group_name                   = "default"
  schedule_expression          = var.medium_collector_rate
  schedule_expression_timezone = "Asia/Kolkata"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.medium_collector.arn
    role_arn = aws_iam_role.medium_collector_scheduler.arn
    input    = "{}"

    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 2
    }
  }
}
