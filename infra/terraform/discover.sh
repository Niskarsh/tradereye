#!/usr/bin/env bash
# Finds tradereye's existing (hand-made) AWS pieces and writes imports.tf, so Terraform can take them over and write
# their exact settings (policies included) into generated.tf. READ-ONLY: it only lists and describes, it changes nothing.
#
#   ./discover.sh inventory                   list everything in the account (all regions) to catch forgotten pieces
#   ./discover.sh users                       list IAM users with access keys (to tell which key is Vercel's / GitHub's)
#   ./discover.sh imports --users a,b [--timer-role <name>] [--ec2 <instance-id> [--ec2-region <region>]]
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

if [ "$cmd" = "inventory" ]; then
  try() { "$@" 2>/dev/null || echo "    (could not list)"; }
  echo "== Account-wide =="
  echo "S3 buckets:";            try aws --profile "$PROFILE" s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | sed 's/^/    /'
  echo "IAM users:";             try aws --profile "$PROFILE" iam list-users --query 'Users[].UserName' --output text | tr '\t' '\n' | sed 's/^/    /'
  echo "IAM roles (not AWS's own service roles):"
  try aws --profile "$PROFILE" iam list-roles --query "Roles[?!starts_with(Path, '/aws-service-role/')].RoleName" --output text | tr '\t' '\n' | sed 's/^/    /'
  echo "Customer-managed IAM policies:"
  try aws --profile "$PROFILE" iam list-policies --scope Local --query 'Policies[].PolicyName' --output text | tr '\t' '\n' | sed 's/^/    /'
  echo "CloudFront distributions:"; try aws --profile "$PROFILE" cloudfront list-distributions --query 'DistributionList.Items[].[Id, DomainName]' --output text | sed 's/^/    /'
  for r in $(aws --profile "$PROFILE" --region "$REGION" ec2 describe-regions --query 'Regions[].RegionName' --output text); do
    echo "  ...checking $r" >&2
    a() { aws --profile "$PROFILE" --region "$r" --cli-connect-timeout 5 --cli-read-timeout 15 "$@" 2>/dev/null; }
    found=""
    x=$(a ec2 describe-instances --query "Reservations[].Instances[?State.Name!='terminated'].[InstanceId, State.Name, PublicIpAddress, Tags[?Key=='Name']|[0].Value]" --output text); [ -n "$x" ] && found+="  EC2 machines (id, state, public IP, name):\n$(echo "$x" | sed 's/^/    /')\n"
    x=$(a ec2 describe-addresses --query 'Addresses[].[PublicIp, AllocationId, InstanceId]' --output text); [ -n "$x" ] && found+="  Elastic IPs (ip, allocation, machine):\n$(echo "$x" | sed 's/^/    /')\n"
    x=$(a lambda list-functions --query 'Functions[].FunctionName' --output text | tr '\t' '\n'); [ -n "$x" ] && found+="  Lambdas:\n$(echo "$x" | sed 's/^/    /')\n"
    x=$(a scheduler list-schedules --query "Schedules[?!starts_with(Name, 'tr-')].[GroupName, Name]" --output text); [ -n "$x" ] && found+="  Scheduler schedules (one-time tr-* wake-ups hidden):\n$(echo "$x" | sed 's/^/    /')\n"
    x=$(a events list-rules --query 'Rules[].Name' --output text | tr '\t' '\n'); [ -n "$x" ] && found+="  EventBridge rules:\n$(echo "$x" | sed 's/^/    /')\n"
    x=$(a elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' --output text); [ -n "$x" ] && found+="  Load balancers: $x\n"
    x=$(a rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text); [ -n "$x" ] && found+="  RDS databases: $x\n"
    x=$(a dynamodb list-tables --query 'TableNames' --output text); [ -n "$x" ] && found+="  DynamoDB tables: $x\n"
    x=$(a sqs list-queues --query 'QueueUrls' --output text); [ -n "$x" ] && [ "$x" != "None" ] && found+="  SQS queues: $x\n"
    x=$(a sns list-topics --query 'Topics[].TopicArn' --output text); [ -n "$x" ] && found+="  SNS topics: $x\n"
    x=$(a apigatewayv2 get-apis --query 'Items[].Name' --output text); [ -n "$x" ] && found+="  API Gateways: $x\n"
    [ -n "$found" ] && printf "== %s ==\n%b" "$r" "$found"
  done
  echo
  echo "Paste this whole output to Claude."
  exit 0
fi

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

USERS=""; EC2=""; EC2_REGION=""; TIMER_ROLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --users) USERS="$2"; shift 2;;
    --ec2) EC2="$2"; shift 2;;
    --ec2-region) EC2_REGION="$2"; shift 2;;
    --timer-role) TIMER_ROLE="$2"; shift 2;;
    *) echo "unknown option $1" >&2; exit 1;;
  esac
done
[ -n "$USERS" ] || { echo "Give the IAM users: --users vercel-user,github-user (see ./discover.sh users)" >&2; exit 1; }

out=imports.tf
echo "# Written by discover.sh on $(date -u +%Y-%m-%dT%H:%MZ). Local only (not committed). Used once with:" > "$out"
echo "#   terraform plan -generate-config-out=generated.tf" >> "$out"
imp() { # once per address (a managed policy attached to two users is imported once); $3 = provider alias, optional
  grep -q "to = $1\$" "$out" && return 0
  if [ -n "${3:-}" ]; then printf 'import {\n  provider = %s\n  to = %s\n  id = "%s"\n}\n\n' "$3" "$1" "$2" >> "$out"
  else printf 'import {\n  to = %s\n  id = "%s"\n}\n\n' "$1" "$2" >> "$out"; fi
  echo "  + $1"
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
  # the machine may live in another region than the bucket: it then goes through the provider aws.trade_assistant
  ER="${EC2_REGION:-$REGION}"; PV=""; [ "$ER" != "$REGION" ] && PV="aws.trade_assistant"
  e2() { aws --profile "$PROFILE" --region "$ER" ec2 "$@"; }
  echo "Trade Assistant machine $EC2 in $ER (its fixed IP is what Dhan whitelists):"
  imp aws_instance.trade_assistant "$EC2" "$PV"
  for sg in $(e2 describe-instances --instance-ids "$EC2" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text); do
    imp "aws_security_group.trade_assistant_$(label "$sg")" "$sg" "$PV"
  done
  eip=$(e2 describe-addresses --filters "Name=instance-id,Values=$EC2" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
  if [ -n "$eip" ] && [ "$eip" != "None" ]; then
    imp aws_eip.trade_assistant "$eip" "$PV"
    assoc=$(e2 describe-addresses --allocation-ids "$eip" --query 'Addresses[0].AssociationId' --output text)
    [ -n "$assoc" ] && [ "$assoc" != "None" ] && imp aws_eip_association.trade_assistant "$assoc" "$PV"
  else
    echo "  ! no Elastic IP on this machine: its IP is the instance's own public IP (tell Claude before changing anything)"
  fi
  [ -n "$PV" ] && echo "  (set ec2_region = \"$ER\" in terraform.tfvars)"
fi

echo
echo "Wrote $out. Next: terraform plan -generate-config-out=generated.tf   (still changes nothing in AWS)"
