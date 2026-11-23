# RampPulse desktop and mobile clients

RampPulse has two desktop modes. Development uses the embedded local service;
release installers use the VPS client build and do not start a local backend or
store operational business data in a local SQLite database. Windows, Linux, and
Android clients share the same web UI and connect to the selected RampPulse
server over HTTPS.

## Development mode

Install Rust, Node.js, Python 3, and the system WebView dependencies required by
Tauri 2. From the repository root:

```sh
python -m pip install -r requirements.txt
npm install
npm run desktop:dev
```

## Client release builds

Install the platform's Tauri prerequisites and run `npm ci`. Use:

```sh
npm run desktop:windows
npm run desktop:linux
npm run android:prepare
npm run android:build
```

Windows builds an NSIS installer, Linux builds DEB and RPM packages, and Android
builds an arm64 APK. The installed client opens a server connection panel on
first launch. Enter the VPS HTTPS API address, check it, save it, then sign in.
The client stores only the server address in app preferences. Passwords are
sent to the selected server over HTTPS and are not included in the app bundle.

## VPS requirements

Run the Rust server on the VPS behind HTTPS. Set `COOKIE_SECURE=1` so the server
issues secure cross-origin session cookies. The server enables credentialed
CORS for Tauri's local app origin and the web development origins. Keep TLS
valid, and allow the API and WebSocket endpoints through the reverse proxy.
Profile photos, banners, operational records, and chat media are uploaded to
and served from that server.

Windows setup executables are written to
`src-tauri/target/release/bundle/nsis/`. Build each Linux package on Linux.
Android release signing still requires the deployment's signing key in the
Android build environment.
