#!/usr/bin/env bash
# Runs ON the genita-server box (Amazon Linux 2023, arm64) as root, sent by deploy.sh via SSM.
#   bash bootstrap.sh <release-id>
# Installs Node 22 once, unpacks s3://$BUCKET/server/releases/<id>.tgz, writes the env file
# from SSM Parameter Store /genita/server/* (SecureStrings decrypted on the box, never echoed),
# restarts the systemd unit and waits for /healthz.
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
id genita >/dev/null 2>&1 || useradd --system --home /var/lib/genita --shell /sbin/nologin genita
mkdir -p $APP/releases /var/lib/genita /etc/genita
chown genita:genita /var/lib/genita
[ -f /opt/genita/rds-ca.pem ] || curl -fsSL -o /opt/genita/rds-ca.pem https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem

# release
D=$APP/releases/$REL
rm -rf "$D" && mkdir -p "$D"
aws s3 cp --only-show-errors "s3://$BUCKET/server/releases/$REL.tgz" /tmp/genita-server.tgz
tar -xzf /tmp/genita-server.tgz -C "$D" && rm -f /tmp/genita-server.tgz
(cd "$D" && $NPM ci --omit=dev --no-audit --no-fund --loglevel=error)
ln -sfn "$D" $APP/current

# env from SSM (names = env var names)
umask 077
aws ssm get-parameters-by-path --path /genita/server --with-decryption --recursive \
  --query 'Parameters[].[Name,Value]' --output text \
  | awk -F'\t' '{ n=$1; sub(".*/","",n); print n "=" $2 }' > /etc/genita/server.env.new
mv /etc/genita/server.env.new /etc/genita/server.env
chmod 600 /etc/genita/server.env
umask 022

cat > /etc/systemd/system/genita-server.service <<EOF
[Unit]
Description=Genita server (Node 22, ws)
After=network-online.target
Wants=network-online.target

[Service]
User=genita
WorkingDirectory=$APP/current
EnvironmentFile=/etc/genita/server.env
Environment=GENITA_ENV_FILE=/nonexistent NODE_ENV=production
ExecStart=$NODE --experimental-strip-types --no-warnings=ExperimentalWarning src/main.ts
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable genita-server >/dev/null 2>&1
systemctl restart genita-server
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    echo "healthy release=$REL node=$($NODE -v)"; curl -s http://127.0.0.1:8787/healthz; echo
    ls -1dt $APP/releases/* | tail -n +6 | xargs -r rm -rf   # keep 5 releases
    exit 0
  fi
  sleep 1
done
journalctl -u genita-server -n 40 --no-pager; exit 1
