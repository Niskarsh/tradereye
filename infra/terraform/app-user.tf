# The IAM user whose access key tradereye uses, in Vercel and in GitHub Actions (backtest, Algo Live model, shorts render).
# Its access key is NOT managed here: Terraform never creates, reads or stores a secret key.

resource "aws_iam_user" "user_trader_eye_journal_uploader" {
  name = var.vercel_iam_user
  path = "/"

  lifecycle {
    prevent_destroy = true
    # the console put the access key's description in a tag; left as it is, and kept out of this public repo
    ignore_changes = [tags, tags_all]
  }
}

# Objects: read / write anywhere in the bucket; listing only where the app lists.
resource "aws_iam_policy" "trader_eye_journal_uploader_policy" {
  name = "trader-eye-journal-uploader-policy"
  path = "/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:PutObjectAcl", "s3:GetObject"]
      Resource = "${local.bucket_arn}/*"
      }, {
      Effect   = "Allow"
      Action   = "s3:ListBucket"
      Resource = local.bucket_arn
      Condition = {
        StringLike = { "s3:prefix" = ["order-book/*", "candles/*", "setups/*"] }
      }
    }]
  })
}

resource "aws_iam_user_policy_attachment" "user_trader_eye_journal_uploader_trader_eye_journal_uploader_policy" {
  user       = aws_iam_user.user_trader_eye_journal_uploader.name
  policy_arn = aws_iam_policy.trader_eye_journal_uploader_policy.arn
}

# The Instagram posting timer: tradereye creates / deletes its one-time wake-ups (tr-*) and hands them the scheduler role.
resource "aws_iam_user_policy" "user_trader_eye_journal_uploader_tradereye_posting_timer" {
  name = "tradereye-posting-timer"
  user = aws_iam_user.user_trader_eye_journal_uploader.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "PostingTimer"
      Effect   = "Allow"
      Action   = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"]
      Resource = "arn:aws:scheduler:${var.region}:${local.account_id}:schedule/default/tr-*"
      }, {
      Sid       = "PassTimerRole"
      Effect    = "Allow"
      Action    = "iam:PassRole"
      Resource  = aws_iam_role.social_timer_scheduler.arn
      Condition = { StringEquals = { "iam:PassedToService" = "scheduler.amazonaws.com" } }
    }]
  })
}
