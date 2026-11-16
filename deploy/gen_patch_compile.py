import tarfile
import base64
import io
import textwrap

def main():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        tar.add('server_go/main.go', arcname='server_go/main.go')
        tar.add('server_go/engine.go', arcname='server_go/engine.go')
        tar.add('server_go/auth.go', arcname='server_go/auth.go')
        tar.add('server_go/ws.go', arcname='server_go/ws.go')
        tar.add('server_go/chat.go', arcname='server_go/chat.go')
        tar.add('frontend/app.js', arcname='frontend/app.js')
        tar.add('frontend/bridge.js', arcname='frontend/bridge.js')
    b64 = textwrap.fill(base64.b64encode(buf.getvalue()).decode('ascii'), 76)

    sh_parts = [
        "#!/usr/bin/env bash",
        "set -e",
        "echo '=== Updating RampPulse Backend & Frontend on VPS ==='",
        "base64 -d << 'EOF' | tar -xz -C /opt/ramppulse",
        b64,
        "EOF",
        "",
        "echo '=== Compiling Go server binary ==='",
        "cd /opt/ramppulse/server_go",
        "go mod tidy",
        "CGO_ENABLED=0 go build -ldflags='-s -w' -o /opt/ramppulse/ramppulse-server .",
        "chmod +x /opt/ramppulse/ramppulse-server",
        "",
        "echo '=== Restarting ramppulse service ==='",
        "systemctl restart ramppulse",
        "sleep 1",
        "",
        "echo '=== Verification ==='",
        "systemctl is-active ramppulse",
        "curl -s http://127.0.0.1:8000/healthz",
        "echo ''",
        "echo '=== State verification ==='",
        "curl -s http://127.0.0.1:8000/api/state | head -c 120",
        "echo ''",
        "echo '=== RampPulse Go Server is RUNNING & UPDATED! ==='",
    ]

    content = '\n'.join(sh_parts)
    with open('deploy/patch_compile.sh', 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

    print(f"Generated deploy/patch_compile.sh! Size: {len(content)}, Lines: {len(content.splitlines())}")

if __name__ == '__main__':
    main()
