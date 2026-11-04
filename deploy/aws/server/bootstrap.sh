#!/usr/bin/env bash
# Runs ON the genita-server box (Amazon Linux 2023, arm64) as root, sent by deploy.sh via SSM.
#   GENITA_BUCKET=... AWS_REGION=... bash bootstrap.sh <release-id>
# Installs Node 22 once, unpacks s3://$BUCKET/server/releases/<id>.tgz, switches `current`,
# restarts the unit (start.mjs reads SSM /genita/server/* at boot, keys never on disk) and
# waits for /healthz; an unhealthy release rolls back to the previous one.
set -euo pipefail
REL=$1
BUCKET=${GENITA_BUCKET:-genita-data-343474957003}
export AWS_DEFAULT_REGION=${AWS_REGION:-us-east-1}
APP=/opt/genita/server

if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  dnf install -y -q nodejs22 nodejs22-npm >/dev/null 2>&1 || true
  if ! command -v node-22 >/dev/null && ! node -v 2>/dev/null | grep -q '^v22'; then
    curl -fsSL https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-arm64.tar.xz | tar -xJ -C /usr/local --strip-components=1
  fi
  command -v node-22 >/dev/null && ln -sf "$(command -v node-22)" /usr/local/bin/node && ln -sf "$(command -v npm-22)" /usr/local/bin/npm
fi
NODE=$(command -v node); NPM=$(command -v npm)

# face-flow prep (genita-server/prep-py/faceflow.py): classical OpenCV (ECC, DIS optical flow), no ML.
# Optional: if this fails the server still runs and face sets ship without `flow` (device patches).
PYFLOW=/opt/genita/pyflow
if [ ! -x $PYFLOW/bin/python ] || ! $PYFLOW/bin/python -c 'import cv2, numpy' >/dev/null 2>&1; then
  dnf install -y -q python3 python3-pip >/dev/null 2>&1 || true
  python3 -m venv $PYFLOW >/dev/null 2>&1 && $PYFLOW/bin/pip install -q --disable-pip-version-check 'numpy<3' 'opencv-python-headless>=4.10,<5' >/dev/null 2>&1 || echo "pyflow: install failed (face flow off)"
fi
PYFLOW_ENV=""
$PYFLOW/bin/python -c 'import cv2, numpy' >/dev/null 2>&1 && PYFLOW_ENV="GENITA_PYFLOW=$PYFLOW/bin/python"
id genita >/dev/null 2>&1 || useradd --system --home /var/lib/genita --shell /sbin/nologin genita
mkdir -p $APP/releases /var/lib/genita
chown genita:genita /var/lib/genita
[ -f /opt/genita/rds-ca.pem ] || curl -fsSL -o /opt/genita/rds-ca.pem https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem

# release (the previous one is kept to roll back to)
PREV=$(readlink -f $APP/current 2>/dev/null || true)
D=$APP/releases/$REL
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
rm -rf "$D" && mkdir -p "$D"
aws s3 cp --only-show-errors "s3://$BUCKET/server/releases/$REL.tgz" "$TMP/server.tgz"
tar -xzf "$TMP/server.tgz" -C "$D"
aws s3 cp --only-show-errors "s3://$BUCKET/server/releases/$REL.start.mjs" "$D/start.mjs"
(cd "$D" && $NPM ci --omit=dev --no-audit --no-fund --loglevel=error)
# parameters must be readable with the instance role before we switch
aws ssm get-parameters-by-path --path /genita/server --with-decryption --query 'length(Parameters)' --output text >/dev/null
ln -sfn "$D" $APP/current
rm -f /etc/genita/server.env   # older releases wrote keys here; start.mjs reads SSM instead

cat > /etc/systemd/system/genita-server.service <<UNIT
[Unit]
Description=Genita server (Node 22, ws)
After=network-online.target
Wants=network-online.target

[Service]
User=genita
WorkingDirectory=$APP/current
Environment=GENITA_ENV_FILE=/nonexistent NODE_ENV=production AWS_REGION=$AWS_DEFAULT_REGION NODE_EXTRA_CA_CERTS=/opt/genita/rds-ca.pem ${PYFLOW_ENV:-GENITA_PYFLOW=0}
ExecStart=$NODE --experimental-strip-types --no-warnings=ExperimentalWarning start.mjs
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable genita-server >/dev/null 2>&1

healthy() {
  systemctl restart genita-server
  for i in $(seq 1 60); do
    curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
if healthy; then
  echo "healthy release=$REL node=$($NODE -v)"; curl -s http://127.0.0.1:8787/healthz; echo
  journalctl -u genita-server -n 6 --no-pager -o cat | grep -E "ssm:|listening|migrated" || true
  ls -1dt $APP/releases/* | tail -n +6 | xargs -r rm -rf   # keep 5 releases
  exit 0
fi
journalctl -u genita-server -n 40 --no-pager -o cat
if [ -n "$PREV" ] && [ -d "$PREV" ] && [ "$PREV" != "$D" ]; then
  echo "ROLLBACK to $(basename "$PREV")"
  ln -sfn "$PREV" $APP/current
  if [ ! -f "$PREV/start.mjs" ]; then cp "$D/start.mjs" "$PREV/start.mjs"; fi
  healthy && echo "rolled back, healthy" || echo "rollback also unhealthy"
fi
exit 1
