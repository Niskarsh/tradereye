# The Instagram posting timer (docs/social.md): tradereye sets one-time EventBridge Scheduler wake-ups (tr-*, NOT managed
# here: tradereye creates and deletes them) that run this Lambda, which calls tradereye's /api/social/tick.
# Code: ../social-timer/index.mjs (change it, then terraform apply).

data "archive_file" "social_timer" {
  type        = "zip"
  source_file = "${path.module}/../social-timer/index.mjs"
  output_path = "${path.module}/.build/social-timer.zip"
}

resource "aws_iam_role" "social_timer" {
  name = "tradereye-social-timer-role-gcf7ea8o"
  path = "/service-role/"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_policy" "awslambdabasicexecutionrole_cf79c7c4_467b_4967_ba19_0780ec2893bd" {
  name = "AWSLambdaBasicExecutionRole-cf79c7c4-467b-4967-ba19-0780ec2893bd"
  path = "/service-role/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "logs:CreateLogGroup"
      Resource = "arn:aws:logs:${var.region}:${local.account_id}:*"
      }, {
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/tradereye-social-timer:*"]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "role_social_timer_awslambdabasicexecutionrole_cf79c7c4_467b_4967_ba19_0780ec2893bd" {
  role       = aws_iam_role.social_timer.name
  policy_arn = aws_iam_policy.awslambdabasicexecutionrole_cf79c7c4_467b_4967_ba19_0780ec2893bd.arn
}

resource "aws_cloudwatch_log_group" "social_timer" {
  name              = "/aws/lambda/tradereye-social-timer"
  retention_in_days = 0 # never expire (as it was made)
}

resource "aws_lambda_function" "social_timer" {
  function_name    = "tradereye-social-timer"
  role             = aws_iam_role.social_timer.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 120
  filename         = data.archive_file.social_timer.output_path
  source_code_hash = data.archive_file.social_timer.output_base64sha256

  environment {
    variables = {
      TICK_URL    = "https://tradereye.candlesbeforecubicles.com/api/social/tick"
      CRON_SECRET = var.cron_secret
    }
  }
}

# The role EventBridge Scheduler uses to run the Lambda (SOCIAL_TIMER_ROLE_ARN in Vercel).
resource "aws_iam_role" "social_timer_scheduler" {
  name = "tradereye-scheduler"
  path = "/"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "scheduler.amazonaws.com" }
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "role_social_timer_scheduler_invoke_social_timer" {
  name = "invoke-social-timer"
  role = aws_iam_role.social_timer_scheduler.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = [aws_lambda_function.social_timer.arn, "${aws_lambda_function.social_timer.arn}:*"]
    }]
  })
}
