#!/usr/bin/env bash
# One-command redeploy of genita-server to the genita-server EC2 box.
#   deploy/aws/server/deploy.sh [git-ref]   (default: origin/main if it has genita-server/, else origin/integration/hackathon)
# git archive of genita-server/ at that ref -> S3 -> SSM run-command bootstrap.sh on the box.
# Runs from any clone of bagel-labs-beni/genita with AWS access (AWS_PROFILE, default genita-login).
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-genita-login} AWS_REGION=${AWS_REGION:-us-east-1}
BUCKET=${GENITA_BUCKET:-genita-data-343474957003}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel)
git -C "$REPO" fetch -q origin 2>/dev/null || true
# default: origin/main once the server is merged there, else the integration branch
if [ -n "${1:-}" ]; then REF=$1
elif git -C "$REPO" cat-file -e origin/main:genita-server/package.json 2>/dev/null; then REF=origin/main
else REF=origin/integration/hackathon; fi
SHA=$(git -C "$REPO" rev-parse --short=12 "$REF^{commit}")
# the box has no AWS keys: S3 needs GENITA_S3_CREDS=imds support (genita-server/src/storage/imds.ts)
git -C "$REPO" cat-file -e "$SHA:genita-server/src/storage/imds.ts" 2>/dev/null \
  || { echo "$REF has no genita-server/src/storage/imds.ts (merge the deploy/aws PR into it first)"; exit 1; }
REL="$(date -u +%Y%m%d-%H%M%S)-$SHA"
IID=${SERVER_INSTANCE_ID:-$(aws ec2 describe-instances --filters Name=tag:Name,Values=genita-server Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)}
[ "$IID" != "None" ] || { echo "genita-server instance is not running"; exit 1; }

TMP=$(mktemp -t genita-server).tgz
git -C "$REPO" archive --format=tar.gz -o "$TMP" "$SHA:genita-server"
aws s3 cp --only-show-errors "$TMP" "s3://$BUCKET/server/releases/$REL.tgz"
aws s3 cp --only-show-errors "$HERE/start.mjs" "s3://$BUCKET/server/releases/$REL.start.mjs"
aws s3 cp --only-show-errors "$HERE/bootstrap.sh" "s3://$BUCKET/server/bootstrap.sh"
rm -f "$TMP"
echo "release $REL ($REF) -> $IID"

CID=$(aws ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript --comment "genita-server $REL" \
  --parameters "commands=[\"aws s3 cp --only-show-errors s3://$BUCKET/server/bootstrap.sh /tmp/genita-server-bootstrap.sh --region $AWS_REGION && GENITA_BUCKET=$BUCKET AWS_REGION=$AWS_REGION bash /tmp/genita-server-bootstrap.sh $REL\"],executionTimeout=[\"900\"]" \
  --query Command.CommandId --output text)
while :; do
  S=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)
  case $S in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 3
done
aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -15
[ "$S" = Success ]
