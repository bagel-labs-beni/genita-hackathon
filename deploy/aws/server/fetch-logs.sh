#!/usr/bin/env bash
# Read-only journald pull for funnel measurements. It never reads or prints secrets;
# the Genita server writes structured event logs without credentials.
#
# Usage: deploy/aws/server/fetch-logs.sh [--since "2 hours ago"] [--out file]
# Set GENITA_LOG_BUCKET to avoid the SSM StandardOutputContent size cap (~24 KB).
set -euo pipefail

export AWS_PROFILE=${AWS_PROFILE:-genita-login}
export AWS_REGION=${AWS_REGION:-us-east-1}
raw=''

usage() {
  cat <<'EOF'
Usage: fetch-logs.sh [--since "2 hours ago"] [--out file]

Fetches JSON event lines from journalctl -u genita-server through SSM.
Set GENITA_LOG_BUCKET to have SSM write the full command output to S3; without it,
SSM StandardOutputContent is capped at about 24 KB.
EOF
}

valid_since() {
  # Keep this deliberately narrow: its value is interpolated into the remote
  # journalctl command after validation.
  printf '%s\n' "$1" | LC_ALL=C grep -Eq \
    '^([0-9]+ (minutes|hours|days) ago|[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?)$'
}

filter_json_lines() {
  # journalctl -o cat emits the application line verbatim. Do not accept
  # prefixed/unstructured output: funnel:report consumes JSONL only.
  awk 'index($0, "{") == 1 { print }'
}

run_selftest() {
  valid_since '2 hours ago'
  valid_since '15 minutes ago'
  valid_since '2026-11-03T12:30:00Z'
  if valid_since '2 hours ago; id'; then
    echo 'validator accepted unsafe input' >&2
    return 1
  fi
  echo 'validator: valid inputs accepted; unsafe input rejected'
  printf '%s\n' '{"event":"face.uploaded"}' 'systemd: not JSON' ' {"event":"prefixed"}' '{"event":"tts.fallback_device"}' \
    | filter_json_lines
}

main() {
  local since='2 hours ago'
  local out="./genita-logs-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
  local iid command_id status remote_command output_dir output_name output_path
  local s3_prefix run_id log_bucket line_count

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --since)
        [ "$#" -ge 2 ] || { echo '--since needs a value' >&2; usage >&2; return 2; }
        since=$2
        shift 2
        ;;
      --out)
        [ "$#" -ge 2 ] || { echo '--out needs a file' >&2; usage >&2; return 2; }
        out=$2
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        echo "unknown argument: $1" >&2
        usage >&2
        return 2
        ;;
    esac
  done

  valid_since "$since" || { echo "unsafe --since value: $since" >&2; return 2; }
  output_dir=$(dirname "$out")
  output_name=$(basename "$out")
  [ -d "$output_dir" ] || { echo "output directory does not exist: $output_dir" >&2; return 2; }
  output_path="$(cd "$output_dir" && pwd -P)/$output_name"

  iid=${SERVER_INSTANCE_ID:-$(aws ec2 describe-instances \
    --filters Name=tag:Name,Values=genita-server Name=instance-state-name,Values=running \
    --query 'Reservations[0].Instances[0].InstanceId' --output text)}
  [ "$iid" != 'None' ] && [ -n "$iid" ] || { echo 'genita-server instance is not running' >&2; return 1; }

  # valid_since excludes shell metacharacters, so this remains a read-only command.
  remote_command="journalctl -u genita-server --since '$since' -o cat --no-pager"
  log_bucket=${GENITA_LOG_BUCKET:-}
  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  s3_prefix="fetch-logs/$run_id"

  if [ -n "$log_bucket" ]; then
    command_id=$(aws ssm send-command --instance-ids "$iid" --document-name AWS-RunShellScript \
      --comment 'genita-server read-only journal fetch' \
      --parameters "commands=[\"$remote_command\"],executionTimeout=[\"300\"]" \
      --output-s3-bucket-name "$log_bucket" --output-s3-key-prefix "$s3_prefix" \
      --query Command.CommandId --output text)
  else
    echo 'warning: GENITA_LOG_BUCKET is unset; SSM output may be truncated at about 24 KB' >&2
    command_id=$(aws ssm send-command --instance-ids "$iid" --document-name AWS-RunShellScript \
      --comment 'genita-server read-only journal fetch' \
      --parameters "commands=[\"$remote_command\"],executionTimeout=[\"300\"]" \
      --query Command.CommandId --output text)
  fi

  while :; do
    status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$iid" \
      --query Status --output text 2>/dev/null || printf 'Pending')
    case "$status" in
      Success|Failed|Cancelled|TimedOut) break ;;
    esac
    sleep 3
  done

  if [ "$status" != 'Success' ]; then
    aws ssm get-command-invocation --command-id "$command_id" --instance-id "$iid" \
      --query '[Status,StandardErrorContent]' --output text >&2 || true
    return 1
  fi

  raw=$(mktemp "${TMPDIR:-/tmp}/genita-fetch-logs.XXXXXX")
  trap 'rm -f "$raw"' EXIT HUP INT TERM
  if [ -n "$log_bucket" ]; then
    # This is the documented Run Command S3 layout for AWS-RunShellScript.
    aws s3 cp --only-show-errors \
      "s3://$log_bucket/$s3_prefix/$command_id/$iid/awsrunShellScript/0.awsrunShellScript/stdout" "$raw"
  else
    aws ssm get-command-invocation --command-id "$command_id" --instance-id "$iid" \
      --query StandardOutputContent --output text > "$raw"
  fi

  filter_json_lines < "$raw" > "$output_path"
  line_count=$(wc -l < "$output_path" | tr -d ' ')
  echo "Fetched $line_count JSON event lines to $output_path"
  echo "cd genita-server && npm run funnel:report -- $output_path"
}

if [ "${FETCH_LOGS_SELFTEST:-}" = '1' ]; then
  run_selftest
elif [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
