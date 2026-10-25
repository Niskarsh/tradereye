# The account id comes from AWS at plan time, so it never has to be written in this (public) repo.
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  bucket_arn = "arn:aws:s3:::${var.bucket}"
}
