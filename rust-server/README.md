# RampPulse Rust service

The Rust service is a staged replacement for the existing Go/Python backend. It is not the
production entrypoint yet: the current desktop and VPS still use their existing runtime.

## Local run

From the repository root:

```sh
DB_FILE=./ramppulse-rust.db \
AIRPORT_FILE=./data/airport_sheremetyevo.json \
PORT=8001 \
cargo run --release --manifest-path rust-server/Cargo.toml
```

For a local presentation only, set `DEMO_MODE=1`; this creates the demo users and makes the
demo credentials available from `/api/meta`. Do not enable it on a publicly reachable server.

The default bind is loopback. Set `HOST=0.0.0.0` only behind the existing reverse
proxy/firewall.
Set `COOKIE_SECURE=1` when the browser connects through HTTPS and `FRONTEND_DIR=./frontend` to
serve the included UI. The SQLite file must live on persistent storage and be writable by the
service account. The airport file is loaded once during startup, so restart after changing it.

## Current endpoints

See [`../docs/Rust-Migration.md`](../docs/Rust-Migration.md) for the API and migration status.
The Rust service supports accounts, engineer admission, request lifecycle, shift start/end,
airport data, route preview, compatible shift snapshots, basic aircraft/technician simulation,
server-backed text/sticker chat, read markers, call signaling and an authenticated WebSocket
event stream. Durable event replay, server file uploads, full Go parity, and the production
desktop release package are still pending. Tauri's desktop build now embeds this Rust service
as its local backend and serves the frontend from the same process.

## Deployment boundary

Do not replace the active Go/Python service with this binary until the remaining state engine,
chat and calls have been migrated and the desktop client speaks the new protocol. When staging
begins, use a separate port and database backup; do not point two server processes at the live
database for writes.
