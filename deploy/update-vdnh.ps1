param([int]$Port = 22)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = 'root@31.56.179.117'
$id = [guid]::NewGuid().ToString('N')
$archive = Join-Path ([IO.Path]::GetTempPath()) "ramppulse-$id.tar.gz"
$remoteArchive = "/root/ramppulse-$id.tar.gz"
$remoteScript = @'
set -eu
archive=$1
base=/opt/ramppulse
unit=ramppulse-server
systemctl show "$unit" -p ExecStart --value | grep -Fq "$base/bin/ramppulse-server"
test -f "$base/bin/ramppulse-server"
test -d "$base/frontend"
cargo_bin=$(command -v cargo || printf '%s' /root/.cargo/bin/cargo)
test -x "$cargo_bin"
stage=$(mktemp -d "$base/.vdnh-update.XXXXXX")
tar -xzf "$archive" -C "$stage"
"$cargo_bin" build --locked --release --manifest-path "$stage/rust-server/Cargo.toml"
install -m 755 "$CARGO_TARGET_DIR/release/ramppulse-server" "$stage/server.new"
backup="$base/backup-vdnh-$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir "$backup"
cp -a "$base/bin/ramppulse-server" "$backup/server"
mv "$base/frontend" "$backup/frontend"
rollback() {
    mv -f "$backup/server" "$base/bin/ramppulse-server"
    if [ -d "$base/frontend" ]; then mv "$base/frontend" "$stage/frontend.failed"; fi
    mv "$backup/frontend" "$base/frontend"
    systemctl restart "$unit"
}
if mv "$stage/web/dist" "$base/frontend" &&
   mv -f "$stage/server.new" "$base/bin/ramppulse-server" &&
   systemctl restart "$unit" &&
   curl -fsS --retry 8 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:8001/healthz | grep -q 'IT2026 Aero GeoData'; then
    rm -f "$archive"
    rm -rf -- "$stage"
    printf 'VDNH is active. Backup: %s\n' "$backup"
else
    rollback
    exit 1
fi
'@
Push-Location $root
try {
    npm.cmd run ui:build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    tar.exe -czf $archive -C $root rust-server/Cargo.toml rust-server/Cargo.lock rust-server/src rust-core/Cargo.toml rust-core/src data/airport_vdnh.json web/dist
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the update' }
    scp.exe -P $Port $archive "${target}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }
    $normalized = $remoteScript.Replace("`r`n", "`n")
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($normalized))
    $unit = "ramppulse-vdnh-update-$id"
    $remoteRunner = "/root/ramppulse-$id.sh"
    ssh.exe -p $Port -o ServerAliveInterval=15 $target "umask 077; printf '%s' '$encoded' | base64 -d > '$remoteRunner' && systemd-run --unit=$unit --setenv=CARGO_BUILD_JOBS=1 --setenv=CARGO_TARGET_DIR=/root/.cache/ramppulse-vdnh-target /bin/bash '$remoteRunner' '$remoteArchive'"
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the VPS job. Check its status before retrying.' }
    Write-Host "Build started. To follow the log: ssh.exe -p $Port $target journalctl -u $unit -n 60 -f"
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
}
