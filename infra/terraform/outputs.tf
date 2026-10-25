output "medium_collector_lambda" {
  value = aws_lambda_function.medium_collector.function_name
}

output "medium_collector_schedule" {
  value = "${aws_scheduler_schedule.medium_collector.name} (${var.medium_collector_rate}, Asia/Kolkata)"
}
