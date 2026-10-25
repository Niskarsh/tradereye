# tradereye on AWS, with Terraform

Every permanent AWS piece is written here: changes are made by editing these files and running `terraform apply`,
not in the console.

| File | What |
|---|---|
| `s3.tf` | the tradereye bucket and its settings (public read, CORS, encryption, ownership) |
| `app-user.tf` | the IAM user whose key tradereye uses (Vercel + GitHub Actions), its S3 policy and posting-timer policy |
| `social-timer.tf` | the Instagram timer: Lambda (code `../social-timer/index.mjs`), its role, logs, and the role Scheduler uses |
| `medium-collector.tf` | the Medium trend radar collector: Lambda (code `../medium-collector/index.mjs`), roles, logs, schedule |
| `trade-assistant.tf` | the Trade Assistant EC2 machine, its security group and Elastic IP (the Dhan-whitelisted IP) |

Never managed here: access keys (Terraform never holds a secret key), the Instagram timer's one-time wake-ups
(`tr-ig-...`, tradereye creates and deletes them), and the state bucket itself.

Safety rails: `prevent_destroy` on the bucket, the app user, the EC2 machine, its security group, Elastic IP and its
attachment (any plan that would delete or replace them is refused). The EC2 machine is only recorded, never changed.

## State
Kept in a separate **private** bucket, `tradereye-tfstate-<account id>` (versioned, public access blocked), key
`terraform/tradereye.tfstate`, locked by S3 itself. Not in the tradereye bucket: that one is publicly readable and the
state holds secrets. Created once by hand (see the setup steps).

## Local files (never committed)
`backend.hcl`, `terraform.tfvars` (bucket, user, `cron_secret`), `imports.tf` (written by `discover.sh`, needed for the
first apply only), `generated.tf` (scratch from the takeover).

## Every change
- `terraform plan` shows what would change; `terraform apply` does it (asks for `yes` first).
- Lambda code: edit `../social-timer/index.mjs` or `../medium-collector/index.mjs`, then `terraform apply`.

## How the hand-made pieces were taken over
`discover.sh inventory` (everything in the account), `discover.sh users`, `discover.sh imports ...` (writes
`imports.tf`), `terraform plan -generate-config-out=generated.tf` (their exact settings), then turned into these files.
The resource names match `imports.tf`, so the first `terraform apply` imports them.

## Follow-ups (not done yet, on purpose: first take over exactly as it is)
- The bucket is publicly readable as a whole; only the journal screenshots need it. Narrow it to their folders.
- The Trade Assistant's security group allows SSH (22) and port 3000 from anywhere. With Cloudflare proxying, 3000 can
  be limited to Cloudflare's IP ranges, and SSH to your own IP.
- CRON_SECRET was shared in a chat during the takeover: change it (new value in `terraform.tfvars` and in Vercel, apply).
