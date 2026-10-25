output "medium_collector_lambda" {
  value = aws_lambda_function.medium_collector.function_name
}

output "medium_collector_schedule" {
  value = "${aws_scheduler_schedule.medium_collector.name} (${var.medium_collector_rate}, Asia/Kolkata)"
}

# for Vercel's SOCIAL_TIMER_LAMBDA_ARN / SOCIAL_TIMER_ROLE_ARN (docs/env.md)
output "social_timer_lambda_arn" {
  value = aws_lambda_function.social_timer.arn
}

output "social_timer_role_arn" {
  value = aws_iam_role.social_timer_scheduler.arn
}
