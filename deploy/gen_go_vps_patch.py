import zlib, base64, pathlib

files = [
    'server_go/go.mod',
    'server_go/auth.go',
    'server_go/chat.go',
    'server_go/engine.go',
    'server_go/ws.go',
    'server_go/main.go',
]

sh = [
    '#!/usr/bin/env bash',
    'set -e',
    'echo "=============================================="',
    'echo "🚀 Deploying High-Performance Go Server on VPS"',
    'echo "=============================================="',
    '',
    'mkdir -p /opt/ramppulse/server_go',
    'cd /opt/ramppulse',
    '',
    'python3 - << "PYEOF"',
    'import zlib, base64, pathlib',
]

for f in files:
    content = pathlib.Path(f).read_bytes()
    b64 = base64.b64encode(zlib.compress(content)).decode('ascii')
    var_name = "p_" + f.replace("/", "_").replace(".", "_")
    sh.append(f'{var_name} = "{b64}"')
    sh.append(f'p = pathlib.Path("{f}")')
    sh.append('p.parent.mkdir(parents=True, exist_ok=True)')
    sh.append(f'p.write_bytes(zlib.decompress(base64.b64decode({var_name})))')
    sh.append(f'print("[+] {f} written successfully")')

sh.extend([
    'PYEOF',
    '',
    'echo "[1/4] Checking Go toolchain..."',
    'if ! command -v go &>/dev/null; then',
    '    echo "Installing Go (golang-go)..."',
    '    export DEBIAN_FRONTEND=noninteractive',
    '    apt-get update -y && apt-get install -y golang-go git',
    'fi',
    'go version',
    '',
    'echo "[2/4] Compiling Go server binary..."',
    'cd /opt/ramppulse/server_go',
    'go mod tidy',
    'CGO_ENABLED=0 go build -ldflags="-s -w" -o /opt/ramppulse/ramppulse-server .',
    'chmod +x /opt/ramppulse/ramppulse-server',
    'ls -lh /opt/ramppulse/ramppulse-server',
    '',
    'echo "[3/4] Configuring systemd service..."',
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
    'echo "[4/4] Verifying Go server..."',
    'systemctl is-active ramppulse',
    'curl -s http://127.0.0.1:8000/healthz',
    'echo ""',
    'curl -s "http://127.0.0.1:8000/api/users/search?q=orlov" | head -c 200',
    'echo ""',
    'echo "=============================================="',
    'echo "✅ RampPulse Go Server is active and running!"',
    'echo "=============================================="',
])

script_content = '\n'.join(sh)
with open('deploy/deploy_go_vps.sh', 'w', encoding='utf-8', newline='\n') as f:
    f.write(script_content)
print("Generated deploy/deploy_go_vps.sh, length:", len(script_content))
