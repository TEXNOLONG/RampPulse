import zlib, base64, pathlib

files = [
    'backend/auth.py',
    'backend/chat.py',
    'backend/main.py',
    'frontend/chat.js',
    'frontend/chat.css',
    'frontend/index.html',
    'frontend/engineer.html',
    'frontend/app.js',
]

sh = ['#!/usr/bin/env bash', 'set -e', 'echo "=== Updating RampPulse on VPS ==="', 'cd /opt/ramppulse', '', 'python3 - << "PYEOF"', 'import zlib, base64, pathlib']

for f in files:
    content = pathlib.Path(f).read_bytes()
    b64 = base64.b64encode(zlib.compress(content)).decode('ascii')
    var_name = "p_" + f.replace("/", "_").replace(".", "_")
    sh.append(f'{var_name} = "{b64}"')
    sh.append(f'pathlib.Path("{f}").write_bytes(zlib.decompress(base64.b64decode({var_name})))')
    sh.append(f'print("[+] {f} written successfully")')

sh.extend([
    'PYEOF',
    '',
    'nginx -t && systemctl reload nginx || true',
    'systemctl restart ramppulse',
    'sleep 1',
    '',
    'echo "=== Verification ==="',
    'curl -s http://127.0.0.1:8000/healthz',
    'echo ""',
    'curl -s "http://127.0.0.1:8000/api/users/search?q=orlov" || true',
    'echo ""',
    'echo "=== VPS Update Complete! ==="'
])

pathlib.Path('deploy/patch_vps.sh').write_text('\n'.join(sh), encoding='utf-8')
print("Generated deploy/patch_vps.sh successfully! Size:", len('\n'.join(sh)))
