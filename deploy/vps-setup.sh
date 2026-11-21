#!/usr/bin/env bash
# RampPulse VPS setup (Ubuntu 22.04/24.04). Idempotent: safe to re-run on every deploy.
# Runs ON the VPS as root. Expects the release in /opt/ramppulse/{bin,frontend,data}.
#
#   sudo bash /opt/ramppulse/deploy/vps-setup.sh [domain] [demo]
#     domain  default: <public-ip-with-dashes>.sslip.io  (free HTTPS, no domain purchase)
#     demo    1 = demo accounts shown on the login page (contest), 0 = production
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }

public_ip="$(curl -4 -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
domain="${1:-${public_ip//./-}.sslip.io}"
demo="${2:-1}"
app=/opt/ramppulse
state=/var/lib/ramppulse
# The release is staged with mktemp (0700) before upload; make the deployed
# read-only application tree traversable by the unprivileged service account.
chmod 0755 "$app"
db_file="$state/ramppulse.db"
if [[ -f "$state/dispatch.db" ]]; then
  # The VPS previously ran the Go server against this SQLite database. The
  # Rust schema migrates its account/session columns in place, preserving the
  # existing engineer logins instead of creating a blank database.
  db_file="$state/dispatch.db"
  echo "==> reusing existing account database: ${db_file}"
fi

echo "==> RampPulse on https://${domain} (ip ${public_ip}, demo=${demo})"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy coturn openssl ufw docker.io >/dev/null
systemctl enable --now docker >/dev/null

# Legacy Python / Go / tunnel services are replaced by the Rust server.
for legacy in ramppulse ramppulse-tunnel ramppulse-go ramppulse-rust; do
  systemctl disable --now "${legacy}.service" >/dev/null 2>&1 || true
done
rm -rf /etc/systemd/system/ramppulse.service.d

id ramppulse >/dev/null 2>&1 || useradd --system --home "$state" --shell /usr/sbin/nologin ramppulse
install -d -o ramppulse -g ramppulse -m 0750 "$state" "$state/chat-attachments"
chmod 0755 "$app/bin/ramppulse-server"

# ---- TURN (coturn) with time-limited REST credentials ----
if [[ ! -f /etc/ramppulse/turn.env ]]; then
  install -d -m 0750 /etc/ramppulse
  secret="$(openssl rand -hex 32)"
  cat > /etc/ramppulse/turn.env <<EOF
STUN_URLS=stun:${public_ip}:3478,stun:stun.l.google.com:19302
TURN_URLS=turn:${public_ip}:3478?transport=udp,turn:${public_ip}:3478?transport=tcp
TURN_SHARED_SECRET=${secret}
EOF
  chmod 0640 /etc/ramppulse/turn.env; chgrp ramppulse /etc/ramppulse/turn.env
fi
secret="$(grep ^TURN_SHARED_SECRET= /etc/ramppulse/turn.env | cut -d= -f2)"
cat > /etc/turnserver.conf <<EOF
listening-port=3478
listening-ip=0.0.0.0
external-ip=${public_ip}
realm=${domain}
fingerprint
use-auth-secret
static-auth-secret=${secret}
stale-nonce=600
total-quota=100
user-quota=12
min-port=49160
max-port=49260
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
no-cli
EOF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable --now coturn >/dev/null
systemctl restart coturn

# ---- Native voice calls (LiveKit SFU) ----
# Calls use a native Rust/WebRTC audio engine in desktop and Android clients;
# this SFU is the media relay required when peers are behind carrier NATs.
install -d -m 0750 /etc/livekit
if [[ ! -f /etc/ramppulse/livekit.env ]]; then
  livekit_key="LK$(openssl rand -hex 6)"
  livekit_secret="$(openssl rand -hex 24)"
  cat > /etc/ramppulse/livekit.env <<EOF
LIVEKIT_URL=wss://calls.${domain}
LIVEKIT_API_KEY=${livekit_key}
LIVEKIT_API_SECRET=${livekit_secret}
EOF
  chmod 0640 /etc/ramppulse/livekit.env; chgrp ramppulse /etc/ramppulse/livekit.env
fi
livekit_key="$(grep ^LIVEKIT_API_KEY= /etc/ramppulse/livekit.env | cut -d= -f2)"
livekit_secret="$(grep ^LIVEKIT_API_SECRET= /etc/ramppulse/livekit.env | cut -d= -f2)"
cat > /etc/livekit.yaml <<EOF
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  ${livekit_key}: ${livekit_secret}
EOF
chmod 0640 /etc/livekit.yaml
docker pull livekit/livekit-server:latest >/dev/null
docker rm -f ramppulse-livekit >/dev/null 2>&1 || true
docker run -d --name ramppulse-livekit --network host --restart unless-stopped \
  -v /etc/livekit.yaml:/livekit.yaml:ro livekit/livekit-server:latest --config /livekit.yaml >/dev/null

# ---- RampPulse service ----
cat > /etc/systemd/system/ramppulse-server.service <<EOF
[Unit]
Description=RampPulse server (Rust)
After=network-online.target
Wants=network-online.target

[Service]
User=ramppulse
Group=ramppulse
WorkingDirectory=${app}
EnvironmentFile=/etc/ramppulse/turn.env
EnvironmentFile=/etc/ramppulse/livekit.env
EnvironmentFile=-/etc/ramppulse/fcm.env
Environment=HOST=127.0.0.1
Environment=PORT=8001
Environment=DB_FILE=${db_file}
Environment=CHAT_STORAGE_DIR=${state}/chat-attachments
Environment=AIRPORT_FILE=${app}/data/airport_sheremetyevo.json
Environment=FRONTEND_DIR=${app}/frontend
Environment=COOKIE_SECURE=1
Environment=COOKIE_SAMESITE=None
Environment=DEMO_MODE=${demo}
ExecStart=${app}/bin/ramppulse-server
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${state}
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ramppulse-server >/dev/null
systemctl restart ramppulse-server

# ---- HTTPS reverse proxy (automatic Let's Encrypt certificate) ----
cat > /etc/caddy/Caddyfile <<EOF
${domain} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8001
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy same-origin
		Permissions-Policy "microphone=(self), camera=()"
	}
}

calls.${domain} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:7880
}
EOF
# Nginx from the previous HTTP-only deployment owns port 80. Validate first,
# then hand both web ports to Caddy for automatic HTTPS. If Caddy cannot start,
# restore Nginx so the VPS does not stay without its current endpoint.
caddy validate --config /etc/caddy/Caddyfile
systemctl disable --now nginx >/dev/null 2>&1 || true
systemctl enable caddy >/dev/null
if ! systemctl restart caddy; then
  systemctl disable --now caddy >/dev/null 2>&1 || true
  systemctl enable --now nginx >/dev/null 2>&1 || true
  exit 1
fi

# ---- firewall ----
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 3478/tcp >/dev/null
ufw allow 3478/udp >/dev/null
ufw allow 49160:49260/udp >/dev/null
ufw allow 7881/tcp >/dev/null
ufw allow 50000:50100/udp >/dev/null
ufw --force enable >/dev/null

for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8001/healthz >/dev/null 2>&1 && break; sleep 1; done
echo "==> health: $(curl -fsS http://127.0.0.1:8001/healthz || echo FAILED)"
echo "==> URL:    https://${domain}"
echo "==> Calls:  wss://calls.${domain}"
