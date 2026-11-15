#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запусти скрипт от root: bash deploy/install_server.sh" >&2
  exit 1
fi
if [[ ! -f requirements.txt || ! -d backend || ! -d frontend ]]; then
  echo "Не найден корень RampPulse. Распакуй архив и запусти скрипт из каталога проекта." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-venv python3-pip ca-certificates curl gnupg

if ! getent group ramppulse >/dev/null; then
  groupadd --system ramppulse
fi
if ! id -u ramppulse >/dev/null 2>&1; then
  useradd --system --gid ramppulse --home-dir /var/lib/ramppulse --shell /usr/sbin/nologin ramppulse
fi

install -d -o root -g root -m 0755 /opt/ramppulse/app
install -d -o root -g root -m 0755 /opt/ramppulse/venv
tar --exclude='./.git' --exclude='./.venv' --exclude='./node_modules' --exclude='./src-tauri/target' \
  --exclude='*/__pycache__' --exclude='*.pyc' \
  --exclude='./desktop/pkg' --exclude='./desktop/src' -cf - . | tar -xf - -C /opt/ramppulse/app
python3 -m venv /opt/ramppulse/venv
/opt/ramppulse/venv/bin/pip install --disable-pip-version-check -r /opt/ramppulse/app/requirements.txt
chown -R root:root /opt/ramppulse/app

install -m 0644 /opt/ramppulse/app/deploy/ramppulse.service /etc/systemd/system/ramppulse.service

install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared
install -m 0644 /opt/ramppulse/app/deploy/ramppulse-tunnel.service /etc/systemd/system/ramppulse-tunnel.service

systemctl daemon-reload
systemctl enable --now ramppulse.service
systemctl enable --now ramppulse-tunnel.service

echo
echo "RampPulse запущен. Временный HTTPS-адрес появится в журнале cloudflared:"
echo "  journalctl -u ramppulse-tunnel -f"
echo "Проверка backend: curl -fsS http://127.0.0.1:8000/healthz"
