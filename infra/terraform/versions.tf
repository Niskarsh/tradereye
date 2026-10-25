# tradereye's permanent AWS pieces, managed by Terraform (see README.md in this folder).
# State lives in S3 (backend.hcl, not committed); S3 itself does the locking (use_lockfile), so no DynamoDB table.
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 7.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  backend "s3" {
    key          = "terraform/tradereye.tfstate"
    encrypt      = true
    use_lockfile = true
    # bucket and region come from backend.hcl: terraform init -backend-config=backend.hcl
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = { app = "tradereye", managed_by = "terraform" }
  }
}
