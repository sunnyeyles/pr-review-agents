terraform {
  required_version = ">= 1.10"

  # State lives in S3. The bucket/key/region are account-specific, so
  # they are supplied at init time rather than hardcoded here:
  #   terraform init -backend-config=backend.hcl
  # See backend.hcl.example and README.md.
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
}
