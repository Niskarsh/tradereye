#!/usr/bin/env bash
# Finds tradereye's existing (hand-made) AWS pieces and writes imports.tf, so Terraform can take them over and write
# their exact settings (policies included) into generated.tf. READ-ONLY: it only lists and describes, it changes nothing.
#
#   ./discover.sh users                       list IAM users with access keys (to tell which key is Vercel's / GitHub's)
#   ./discover.sh imports --users a,b [--ec2 <instance-id>] [--timer-role <name>]
#                                             write imports.tf for the bucket, those users, the Instagram timer Lambda,
#                                             its roles and log group (and the Trade Assistant EC2 machine if given)
#
# Reads region / bucket / profile from terraform.tfvars. Needs the AWS CLI (no jq).
set -euo pipefail
cd "$(dirname "$0")"

tfvar() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\(.*\)\".*/\1/p" terraform.tfvars | head -1; }
[ -f terraform.tfvars ] || { echo "Copy terraform.tfvars.example to terraform.tfvars and fill it in first." >&2; exit 1; }
REGION="$(tfvar region)"; BUCKET="$(tfvar bucket)"; PROFILE="$(tfvar aws_profile)"; PROFILE="${PROFILE:-tradereye-tf}"
[ -n "$REGION" ] && [ -n "$BUCKET" ] || { echo "terraform.tfvars needs region and bucket." >&2; exit 1; }
aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

# Terraform's own new pieces (medium-collector.tf) are never imported
SKIP_ROLE_PREFIX="tradereye-medium-collector"
SKIP_USER_POLICY="tradereye-read-medium"
TIMER_LAMBDA="tradereye-social-timer"

label() { echo "$1" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9]/_/g; s/__*/_/g; s/^_//; s/_$//'; }

cmd="${1:-}"; shift || true

if [ "$cmd" = "users" ]; then
  echo "IAM users with access keys (user, key id, last used service, last used date):"
  for u in $(aws_ iam list-users --query 'Users[].UserName' --output text); do
    for k in $(aws_ iam list-access-keys --user-name "$u" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
      last=$(aws_ iam get-access-key-last-used --access-key-id "$k" --query '[AccessKeyLastUsed.ServiceName, AccessKeyLastUsed.LastUsedDate]' --output text)
      echo "  $u   $k   $last"
    done
  done
  echo
  echo "Vercel's key: compare with AWS_ACCESS_KEY_ID in Vercel. GitHub Actions' key: GitHub hides secrets, so pick the"
  echo "user whose key was last used around your last backtest / short render (or tell Claude if unsure)."
  exit 0
fi

[ "$cmd" = "imports" ] || { sed -n '2,12p' "$0"; exit 1; }

USERS=""; EC2=""; TIMER_ROLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --users) USERS="$2"; shift 2;;
    --ec2) EC2="$2"; shift 2;;
    --timer-role) TIMER_ROLE="$2"; shift 2;;
    *) echo "unknown option $1" >&2; exit 1;;
  esac
done
[ -n "$USERS" ] || { echo "Give the IAM users: --users vercel-user,github-user (see ./discover.sh users)" >&2; exit 1; }

out=imports.tf
echo "# Written by discover.sh on $(date -u +%Y-%m-%dT%H:%MZ). Local only (not committed). Used once with:" > "$out"
echo "#   terraform plan -generate-config-out=generated.tf" >> "$out"
imp() { # once per address (a managed policy attached to two users is imported once)
  grep -q "to = $1\$" "$out" && return 0
  printf 'import {\n  to = %s\n  id = "%s"\n}\n\n' "$1" "$2" >> "$out"; echo "  + $1"
}
has() { "$@" >/dev/null 2>&1; }

echo "Bucket $BUCKET:"
imp aws_s3_bucket.main "$BUCKET"
has aws_ s3api get-bucket-cors --bucket "$BUCKET" && imp aws_s3_bucket_cors_configuration.main "$BUCKET"
has aws_ s3api get-public-access-block --bucket "$BUCKET" && imp aws_s3_bucket_public_access_block.main "$BUCKET"
has aws_ s3api get-bucket-encryption --bucket "$BUCKET" && imp aws_s3_bucket_server_side_encryption_configuration.main "$BUCKET"
has aws_ s3api get-bucket-ownership-controls --bucket "$BUCKET" && imp aws_s3_bucket_ownership_controls.main "$BUCKET"
has aws_ s3api get-bucket-policy --bucket "$BUCKET" && imp aws_s3_bucket_policy.main "$BUCKET"
has aws_ s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" && imp aws_s3_bucket_lifecycle_configuration.main "$BUCKET"
v=$(aws_ s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text 2>/dev/null || true)
[ "$v" = "Enabled" ] || [ "$v" = "Suspended" ] && imp aws_s3_bucket_versioning.main "$BUCKET"

# a role's or user's policies: inline ones, customer-managed ones (and their attachments), AWS-managed attachments
policies_of() { # kind(role|user) name label
  local kind="$1" name="$2" l="$3" p arn pl
  for p in $(aws_ iam list-${kind}-policies --${kind}-name "$name" --query 'PolicyNames[]' --output text); do
    [ "$p" = "$SKIP_USER_POLICY" ] && continue
    imp "aws_iam_${kind}_policy.${l}_$(label "$p")" "$name:$p"
  done
  for arn in $(aws_ iam list-attached-${kind}-policies --${kind}-name "$name" --query 'AttachedPolicies[].PolicyArn' --output text); do
    pl="$(label "${arn##*/}")"
    case "$arn" in arn:aws:iam::aws:policy/*) ;; *) imp "aws_iam_policy.${pl}" "$arn";; esac
    imp "aws_iam_${kind}_policy_attachment.${l}_${pl}" "$name/$arn"
  done
}

for u in $(echo "$USERS" | tr ',' ' '); do
  echo "IAM user $u (access keys are left alone: Terraform never holds them):"
  l="user_$(label "$u")"
  imp "aws_iam_user.$l" "$u"
  policies_of user "$u" "$l"
done

if aws_ lambda get-function --function-name "$TIMER_LAMBDA" >/dev/null 2>&1; then
  echo "Instagram timer Lambda $TIMER_LAMBDA:"
  imp aws_lambda_function.social_timer "$TIMER_LAMBDA"
  role=$(aws_ lambda get-function-configuration --function-name "$TIMER_LAMBDA" --query Role --output text); role="${role##*/}"
  imp aws_iam_role.social_timer "$role"
  policies_of role "$role" "role_social_timer"
  lg=$(aws_ logs describe-log-groups --log-group-name-prefix "/aws/lambda/$TIMER_LAMBDA" --query "logGroups[?logGroupName=='/aws/lambda/$TIMER_LAMBDA'] | length(@)" --output text 2>/dev/null || echo 0)
  [ "$lg" != "0" ] && imp aws_cloudwatch_log_group.social_timer "/aws/lambda/$TIMER_LAMBDA"
else
  echo "No Lambda named $TIMER_LAMBDA in $REGION (skipped)."
fi

if [ -n "$TIMER_ROLE" ]; then
  echo "Scheduler role for the Instagram timer ($TIMER_ROLE, the end of SOCIAL_TIMER_ROLE_ARN in Vercel):"
  case "$TIMER_ROLE" in $SKIP_ROLE_PREFIX*) echo "  skipped (Terraform's own)";; *)
    imp aws_iam_role.social_timer_scheduler "$TIMER_ROLE"
    policies_of role "$TIMER_ROLE" "role_social_timer_scheduler";; esac
fi

if [ -n "$EC2" ]; then
  echo "Trade Assistant machine $EC2 (its fixed IP is what Dhan whitelists):"
  imp aws_instance.trade_assistant "$EC2"
  for sg in $(aws_ ec2 describe-instances --instance-ids "$EC2" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text); do
    imp "aws_security_group.trade_assistant_$(label "$sg")" "$sg"
  done
  eip=$(aws_ ec2 describe-addresses --filters "Name=instance-id,Values=$EC2" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
  if [ -n "$eip" ] && [ "$eip" != "None" ]; then
    imp aws_eip.trade_assistant "$eip"
    assoc=$(aws_ ec2 describe-addresses --allocation-ids "$eip" --query 'Addresses[0].AssociationId' --output text)
    [ -n "$assoc" ] && [ "$assoc" != "None" ] && imp aws_eip_association.trade_assistant "$assoc"
  else
    echo "  ! no Elastic IP on this machine: its IP is the instance's own public IP (see the chat before changing anything)"
  fi
fi

echo
echo "Wrote $out. Next: terraform plan -generate-config-out=generated.tf   (still changes nothing in AWS)"
