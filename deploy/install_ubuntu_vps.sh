#!/usr/bin/env bash
# ==============================================================================
# Скрипт развёртывания RampPulse на Ubuntu VPS (Ubuntu 22.04 / 24.04 LTS)
# Запуск от root: sudo bash deploy/install_ubuntu_vps.sh
# ==============================================================================
set -euo pipefail

echo "=================================================="
echo "  Установка RampPulse на Ubuntu VPS"
echo "=================================================="

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ошибка: запустите скрипт от root (sudo bash deploy/install_ubuntu_vps.sh)" >&2
  exit 1
fi

APP_DIR="/opt/ramppulse/app"
VENV_DIR="/opt/ramppulse/venv"
DATA_DIR="/var/lib/ramppulse"

echo "[1/6] Обновление пакетов и установка зависимостей..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-venv python3-pip nginx ca-certificates curl ufw

echo "[2/6] Создание системного пользователя и каталогов..."
if ! getent group ramppulse >/dev/null; then
  groupadd --system ramppulse
fi
if ! id -u ramppulse >/dev/null 2>&1; then
  useradd --system --gid ramppulse --home-dir "$DATA_DIR" --shell /usr/sbin/nologin ramppulse
fi

install -d -o ramppulse -g ramppulse -m 0750 "$DATA_DIR"
install -d -o root -g root -m 0755 /opt/ramppulse
install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o root -g root -m 0755 "$VENV_DIR"

echo "[3/6] Копирование файлов проекта в $APP_DIR..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tar --exclude='./.git' --exclude='./.venv' --exclude='./node_modules' --exclude='./src-tauri/target' \
  --exclude='*/__pycache__' --exclude='*.pyc' \
  -cf - -C "$SCRIPT_DIR" . | tar -xf - -C "$APP_DIR"

echo "[4/6] Создание виртуального окружения Python..."
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install --disable-pip-version-check -r "$APP_DIR/requirements.txt"

chown -R root:root "$APP_DIR"
chown -R ramppulse:ramppulse "$DATA_DIR"

echo "[5/6] Настройка службы systemd (ramppulse.service)..."
cat > /etc/systemd/system/ramppulse.service << 'EOF'
[Unit]
Description=RampPulse Airport Operations Hub
After=network.target

[Service]
Type=simple
User=ramppulse
Group=ramppulse
WorkingDirectory=/opt/ramppulse/app
Environment=PYTHONUNBUFFERED=1
Environment=DB_FILE=/var/lib/ramppulse/dispatch.db
Environment=AIRPORT_FILE=/opt/ramppulse/app/data/airport_sheremetyevo.json
Environment=DEMO_MODE=1
ExecStart=/opt/ramppulse/venv/bin/python run.py --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ramppulse.service

echo "[6/6] Настройка Nginx с поддержкой WebSocket..."
cp "$APP_DIR/deploy/nginx_ramppulse.conf" /etc/nginx/sites-available/ramppulse
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/ramppulse /etc/nginx/sites-enabled/ramppulse
nginx -t && systemctl reload nginx

# Настройка файрвола UFW (открываем SSH, HTTP, HTTPS)
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw allow OpenSSH >/dev/null 2>&1 || true

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=================================================="
echo "  RampPulse успешно установлен и запущен!"
echo "=================================================="
echo "Сервер доступен по адресу: http://$IP"
echo "Проверка работы: curl http://127.0.0.1:8000/healthz"
echo "Статус службы: systemctl status ramppulse"
echo "Логи сервера:   journalctl -u ramppulse -f"
echo ""
echo "Для подключения SSL-сертификата выполните:"
echo "  sudo apt install -y certbot python3-certbot-nginx"
echo "  sudo certbot --nginx -d ВАШ_ДОМЕН"
echo "=================================================="
