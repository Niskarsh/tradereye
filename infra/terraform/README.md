# tradereye on AWS, with Terraform

The permanent AWS pieces are written here, so they are created by one command instead of console clicks.

Managed here:
- the Medium collector (`medium-collector.tf`): Lambda `tradereye-medium-collector` (code: `../medium-collector/index.mjs`),
  its role (logs + read/write `medium/*`), its log group (30 days), the EventBridge Scheduler schedule (every 3 hours,
  Asia/Kolkata) and its role, and read access to `medium/*` for the IAM user whose key is in Vercel (a separate policy;
  existing policies are not touched).

Not managed here (on purpose):
- the Instagram timer's one-time wake-ups (`tr-ig-...`): tradereye creates and deletes those itself.
- the Instagram timer Lambda `tradereye-social-timer`, the bucket, the Vercel IAM user: created by hand earlier. They can
  be brought in later with `terraform import`.

## One-time setup
1. Install Terraform 1.10 or newer and the AWS CLI.
2. In IAM, create a user for Terraform (`tradereye-terraform`) with the `AdministratorAccess` policy and an access key
   for the CLI. (Simplest for one person; it can be narrowed later to IAM, Lambda, Scheduler, Logs and the bucket.)
   Keep this key only on your computer: never in Vercel, GitHub or the repo.
3. `aws configure --profile tradereye-tf` and paste that key.
4. In this folder: copy `backend.hcl.example` to `backend.hcl`, `terraform.tfvars.example` to `terraform.tfvars`, fill both.
5. `terraform init -backend-config=backend.hcl`

State is kept in the tradereye bucket at `terraform/tradereye.tfstate` (encrypted, locked by S3 itself).

## Every change
- `terraform plan` shows what would change; `terraform apply` does it (it asks for `yes` first).
- Changing `../medium-collector/index.mjs` and running `terraform apply` updates the Lambda's code.
- Test the collector: `aws lambda invoke --function-name tradereye-medium-collector --profile tradereye-tf out.json && cat out.json`

## Cost
Terraform itself is free; the state file is a few KB in S3. The resources cost what they would if made by hand
(inside the free tiers for the collector).
