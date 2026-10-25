variable "region" {
  description = "AWS region of the tradereye S3 bucket (e.g. ap-south-1)"
  type        = string
}

variable "aws_profile" {
  description = "AWS CLI profile Terraform uses (aws configure --profile <name>)"
  type        = string
  default     = "tradereye-tf"
}

variable "bucket" {
  description = "The S3 bucket tradereye uses (Vercel AWS_S3_BUCKET_NAME)"
  type        = string
}

variable "vercel_iam_user" {
  description = "Name of the IAM user whose access key is in Vercel (AWS_ACCESS_KEY_ID); it gets read access to medium/*"
  type        = string
}

variable "medium_collector_rate" {
  description = "How often the Medium collector runs"
  type        = string
  default     = "rate(3 hours)"
}

variable "ec2_region" {
  description = "Region of the Trade Assistant EC2 machine, when it is not the bucket's region"
  type        = string
  default     = null
}
