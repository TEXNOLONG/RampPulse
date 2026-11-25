$ErrorActionPreference = 'Stop'
$hostName = '31.56.179.117'
$domain = '31-56-179-117.sslip.io'
$portText = Read-Host 'SSH port [22]'
if ([string]::IsNullOrWhiteSpace($portText)) { $portText = '22' }
$port = 22
if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'Invalid SSH port.'
}

$ssh = Get-Command ssh.exe -ErrorAction Stop
$target = "root@$hostName"
$remoteScript = @'
set -eu
domain='31-56-179-117.sslip.io'
config=/etc/caddy/Caddyfile
backup="${config}.backup.windows-cors.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$config" "$backup"
python3 - "$config" "$domain" <<'PY'
from pathlib import Path
import re, sys

path, domain = Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
marker = '# RampPulse Windows WebView loopback CORS'
lines = text.splitlines(keepends=True)
site = re.compile(r'^\s*(?:https?://)?' + re.escape(domain) + r'\s*\{\s*$')
block = '''    # RampPulse Windows WebView loopback CORS
    @windowsApiPreflight {
        method OPTIONS
        path /api/* /healthz
        header_regexp Origin ^http://(127\\.0\\.0\\.1|localhost):[0-9]{1,5}$
    }
    @windowsLoopbackOrigin header_regexp Origin ^http://(127\\.0\\.0\\.1|localhost):[0-9]{1,5}$
    header @windowsLoopbackOrigin {
        >Access-Control-Allow-Origin {http.request.header.Origin}
        >Access-Control-Allow-Credentials true
        >Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS"
        >Access-Control-Allow-Headers "Accept, Authorization, Content-Type, X-Chat-Kind, X-Chat-Duration, X-Chat-File-Name"
        >Vary Origin
    }
    respond @windowsApiPreflight 204
'''
if marker not in text:
    for index, line in enumerate(lines):
        if site.match(line.rstrip('\r\n')):
            lines.insert(index + 1, block)
            text = ''.join(lines)
            print(f'Added loopback CORS rules to {domain}.')
            break
    else:
        raise SystemExit(f'Could not find site block for {domain}; Caddyfile was not changed.')
else:
    print('Updating existing loopback CORS rules to replace upstream headers.')
start = text.index(marker)
end = text.index('respond @windowsApiPreflight', start)
section = text[start:end]
section = re.sub(r'(?m)^(\s*)>?Access-Control-Allow-Origin\s+',
                 r'\1>Access-Control-Allow-Origin ', section)
for name in ('Access-Control-Allow-Credentials', 'Access-Control-Allow-Methods',
             'Access-Control-Allow-Headers', 'Vary'):
    section = re.sub(r'(?m)^(\s*)(?:>?)' + re.escape(name) + r'\s+',
                     r'\1>' + name + ' ', section)
text = text[:start] + section + text[end:]
path.write_text(text)
print('CORS response headers will replace the Rust headers, avoiding duplicates.')
PY
if ! caddy validate --config "$config" --adapter caddyfile; then
  cp -a "$backup" "$config"
  echo 'Caddy validation failed; previous config restored.' >&2
  exit 1
fi
if ! systemctl reload caddy; then
  cp -a "$backup" "$config"
  caddy validate --config "$config" --adapter caddyfile
  systemctl reload caddy
  echo 'Caddy reload failed; previous config restored.' >&2
  exit 1
fi
echo "Caddy reloaded; backup: $backup"
'@

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = "printf '%s' '$encoded' | base64 -d | bash"
$sshOptions = @('-p', "$port", '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'ConnectTimeout=15')
Write-Host "Connecting to ${target}:$port. Enter the password only at the SSH prompt."
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$output = & $ssh.Source @sshOptions $target $remoteCommand 2>&1
$sshExit = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
$output | ForEach-Object { Write-Host "$_" }
if ($sshExit -ne 0) { throw "Caddy update failed (SSH exit $sshExit). The script restores the previous config if validation/reload fails." }

$preflight = & curl.exe -sS -i -X OPTIONS "https://$domain/healthz" -H 'Origin: http://127.0.0.1:57129' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: accept'
if ($LASTEXITCODE -ne 0) { throw 'Caddy reloaded, but the HTTPS preflight probe failed.' }
$preflight | ForEach-Object { Write-Host $_ }
if (($preflight -join "`n") -notmatch '(?im)^Access-Control-Allow-Origin:\s*http://127\.0\.0\.1:57129\s*$') {
    throw 'CORS still does not allow the tested Windows WebView origin. See the preflight output above.'
}
foreach ($headerName in @('Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers')) {
    $matchingHeaders = @($preflight | Where-Object { "$_" -match "(?i)^$([regex]::Escape($headerName))\s*:" })
    if ($matchingHeaders.Count -ne 1) {
        throw "Expected exactly one $headerName response header, found $($matchingHeaders.Count). See the preflight output above."
    }
}
Write-Host 'Windows WebView CORS is working. Restart the desktop app and retry login.'
