import tarfile
import base64
import io
import textwrap
from pathlib import Path

def main():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        tar.add('server_go', arcname='server_go')

    gz_bytes = buf.getvalue()
    b64_wrapped = textwrap.fill(base64.b64encode(gz_bytes).decode('ascii'), 76)

    sh_parts = [
        "#!/usr/bin/env bash",
        "set -e",
        'echo "=============================================="',
        'echo "🚀 Deploying High-Performance Go Server on VPS"',
        'echo "=============================================="',
        "",
        "cd /opt/ramppulse",
        "",
        "echo '[1/4] Unpacking Go sources...'",
        "base64 -d << 'TGZEOF' | tar -xz -C /opt/ramppulse",
        b64_wrapped,
        "TGZEOF",
        "",
        'echo "[2/4] Checking Go toolchain..."',
        'if ! command -v go &>/dev/null; then',
        '    echo "Installing Go (golang-go)..."',
        '    export DEBIAN_FRONTEND=noninteractive',
        '    apt-get update -y && apt-get install -y golang-go git',
        'fi',
        'go version',
        "",
        'echo "[3/4] Compiling Go server binary..."',
        'cd /opt/ramppulse/server_go',
        'go mod tidy',
        'CGO_ENABLED=0 go build -ldflags="-s -w" -o /opt/ramppulse/ramppulse-server .',
        'chmod +x /opt/ramppulse/ramppulse-server',
        'ls -lh /opt/ramppulse/ramppulse-server',
        "",
        'echo "[4/4] Configuring systemd service..."',
        'cat << "SVCEOF" > /etc/systemd/system/ramppulse.service',
        '[Unit]',
        'Description=RampPulse Go Airport Dispatch Server',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'User=root',
        'WorkingDirectory=/opt/ramppulse',
        'ExecStart=/opt/ramppulse/ramppulse-server',
        'Restart=always',
        'RestartSec=3',
        'Environment="PORT=8000"',
        'Environment="DB_FILE=/opt/ramppulse/dispatch.db"',
        'LimitNOFILE=65536',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        'SVCEOF',
        '',
        'systemctl daemon-reload',
        'systemctl restart ramppulse',
        'sleep 1',
        '',
        'echo "=== Verification ==="',
        'systemctl is-active ramppulse',
        'curl -s http://127.0.0.1:8000/healthz',
        'echo ""',
        'curl -s "http://127.0.0.1:8000/api/users/search?q=orlov" | head -c 200',
        'echo ""',
        'echo "=============================================="',
        'echo "✅ RampPulse Go Server is active and running!"',
        'echo "=============================================="',
    ]

    content = '\n'.join(sh_parts)
    with open('deploy/install_go_vps.sh', 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

    print(f"Generated deploy/install_go_vps.sh successfully! Size: {len(content)} bytes, Lines: {len(content.splitlines())}")

if __name__ == '__main__':
    main()
