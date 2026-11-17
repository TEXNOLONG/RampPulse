#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запусти на VPS от root: sudo bash deploy/configure_coturn.sh <публичный-IP>" >&2
  exit 1
fi

public_ip="${1:-}"
if [[ -z "$public_ip" ]] || ! python3 - "$public_ip" <<'PY'
import ipaddress, sys
try:
    ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
PY
then
  echo "Укажи публичный IP VPS, например: sudo bash deploy/configure_coturn.sh 31.56.179.117" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y coturn openssl

turn_secret="$(openssl rand -hex 32)"
install -d -m 0755 /etc/systemd/system/ramppulse.service.d /var/lib/ramppulse/chat-attachments
chown ramppulse:ramppulse /var/lib/ramppulse/chat-attachments

cat > /etc/turnserver.conf <<EOF
listening-port=3478
listening-ip=0.0.0.0
external-ip=${public_ip}
realm=ramppulse
fingerprint
use-auth-secret
static-auth-secret=${turn_secret}
stale-nonce=600
user-quota=10
total-quota=100
min-port=49160
max-port=49200
no-cli
EOF
if getent group turnserver >/dev/null; then
  chown root:turnserver /etc/turnserver.conf
fi
chmod 0640 /etc/turnserver.conf

cat > /etc/ramppulse-turn.env <<EOF
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=turn:${public_ip}:3478?transport=udp,turn:${public_ip}:3478?transport=tcp
TURN_SHARED_SECRET=${turn_secret}
EOF
chown root:root /etc/ramppulse-turn.env
chmod 0600 /etc/ramppulse-turn.env

cat > /etc/systemd/system/ramppulse.service.d/turn.conf <<'EOF'
[Service]
EnvironmentFile=-/etc/ramppulse-turn.env
Environment=CHAT_UPLOAD_DIR=/var/lib/ramppulse/chat-attachments
EOF

if [[ -x "$(command -v ufw || true)" ]] && ufw status | grep -q '^Status: active'; then
  ufw allow 3478/udp
  ufw allow 3478/tcp
  ufw allow 49160:49200/udp
fi

if [[ -f /etc/default/coturn ]]; then
  if grep -q '^TURNSERVER_ENABLED=' /etc/default/coturn; then
    sed -i 's/^TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  else
    printf '\nTURNSERVER_ENABLED=1\n' >> /etc/default/coturn
  fi
fi

systemctl daemon-reload
systemctl enable --now coturn
systemctl restart coturn
systemctl restart ramppulse

echo "coturn и RampPulse перезапущены; общий секрет настроен без вывода в терминал."
echo "Открой также в firewall панели HostVDS: UDP/TCP 3478 и UDP 49160-49200."
echo "Проверь: systemctl status coturn ramppulse --no-pager"
