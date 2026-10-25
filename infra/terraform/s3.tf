# The tradereye bucket (journal screenshots, order book, candles, setups, shorts, social, medium, ...).
# Made by hand first; taken over with an import. prevent_destroy: Terraform refuses any plan that would delete it.
# Terraform's own state is NOT kept here (this bucket is publicly readable): it lives in the private state bucket.

resource "aws_s3_bucket" "main" {
  bucket           = var.bucket
  bucket_namespace = "account-regional"

  lifecycle {
    prevent_destroy = true
  }
}

# Every object is publicly readable: the journal's screenshots are shown by their plain S3 address.
# (Worth narrowing to the screenshot folders later; see README "Follow-ups".)
resource "aws_s3_bucket_policy" "main" {
  bucket = aws_s3_bucket.main.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicRead"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${local.bucket_arn}/*"
    }]
  })
}

resource "aws_s3_bucket_public_access_block" "main" {
  bucket                  = aws_s3_bucket.main.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_ownership_controls" "main" {
  bucket = aws_s3_bucket.main.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "main" {
  bucket = aws_s3_bucket.main.id
  rule {
    blocked_encryption_types = ["SSE-C"]
    bucket_key_enabled       = true
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Browser uploads (presigned PUT) and reads from the app; the thumbnail picker needs GET.
resource "aws_s3_bucket_cors_configuration" "main" {
  bucket = aws_s3_bucket.main.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD", "POST", "PUT"]
    allowed_origins = [
      "http://localhost:3000",
      "https://tradereye-tracer.vercel.app",
      "https://tradereye.candlesbeforecubicles.com",
      "https://www.candlesbeforecubicles.com",
    ]
    expose_headers  = ["ETag", "x-amz-id-2", "x-amz-request-id"]
    max_age_seconds = 3000
  }
}
