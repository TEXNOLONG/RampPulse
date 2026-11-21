#!/usr/bin/env bash
# Build RampPulse locally and ship it to the VPS.
#   bash deploy/deploy.sh [user@host] [domain] [demo]
# Defaults: root@31.56.179.117, <ip>.sslip.io, demo=1. Uses ~/.ssh/ramppulse_vps.
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-root@31.56.179.117}"
domain="${2:-}"
demo="${3:-1}"
key="${RAMPPULSE_SSH_KEY:-$HOME/.ssh/ramppulse_vps}"
ssh_opts=(-i "$key" -o StrictHostKeyChecking=accept-new)

echo "==> building server and web app"
cargo build --release --manifest-path rust-server/Cargo.toml
npm --prefix web run build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/deploy"
cp rust-server/target/release/ramppulse-server "$stage/bin/"
cp -r web/dist "$stage/frontend"
cp -r data "$stage/data"
cp deploy/vps-setup.sh "$stage/deploy/"

echo "==> uploading to ${target}"
tar -C "$stage" -czf - . | ssh "${ssh_opts[@]}" "$target" 'set -e; rm -rf /opt/ramppulse.new; mkdir -p /opt/ramppulse.new; tar -xzf - -C /opt/ramppulse.new; rm -rf /opt/ramppulse.old; [ -d /opt/ramppulse ] && mv /opt/ramppulse /opt/ramppulse.old; mv /opt/ramppulse.new /opt/ramppulse'
ssh "${ssh_opts[@]}" "$target" "bash /opt/ramppulse/deploy/vps-setup.sh '${domain}' '${demo}'"
