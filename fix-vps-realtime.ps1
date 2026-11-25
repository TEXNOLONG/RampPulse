$ErrorActionPreference = 'Stop'
$port = Read-Host 'SSH port [22]'
if ([string]::IsNullOrWhiteSpace($port)) { $port = '22' }
if ($port -notmatch '^\d{1,5}$' -or [int]$port -lt 1 -or [int]$port -gt 65535) { throw 'Invalid SSH port' }
$script = @'
set -eu
config=/etc/caddy/Caddyfile
backup="$config.backup.realtime.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$config" "$backup"
python3 - "$config" <<'PY'
from pathlib import Path
import sys, re
p = Path(sys.argv[1])
text = p.read_text()
marker = '# RampPulse authenticated native WebSocket'
if marker not in text:
    block = '''
    # RampPulse authenticated native WebSocket
    @rampNativeWs {
        path /ws
        header_regexp Origin ^(http://(127\\.0\\.0\\.1|localhost):[0-9]{1,5}|https?://tauri\\.localhost|tauri://localhost)$
    }
    handle @rampNativeWs {
        reverse_proxy 127.0.0.1:8001 {
            header_up Origin https://31-56-179-117.sslip.io
        }
    }
'''
    pattern = r'(?m)^\s*(?:https?://)?31-56-179-117\.sslip\.io\s*\{\s*$'
    text, count = re.subn(pattern, lambda m: m.group(0) + '\n' + block, text, count=1)
    if count != 1:
        raise SystemExit('Site block not found; config unchanged')
    p.write_text(text)
else:
    print('Native WebSocket proxy already configured')
PY
if ! caddy validate --config "$config" --adapter caddyfile; then
    cp -a "$backup" "$config"
    exit 1
fi
if ! systemctl reload caddy; then
    cp -a "$backup" "$config"
    systemctl reload caddy
    exit 1
fi
echo "Backup: $backup"
echo 'Native WebSocket proxy configured. Restart RampPulse and check live connection.'
curl --fail --silent --show-error https://31-56-179-117.sslip.io/healthz
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
Write-Host 'Connecting to root@31.56.179.117. Enter the password at the SSH prompt.'
& ssh.exe -p $port root@31.56.179.117 "printf '%s' '$encoded' | base64 -d | bash"
if ($LASTEXITCODE -ne 0) { throw "VPS fix failed: SSH exit $LASTEXITCODE" }
