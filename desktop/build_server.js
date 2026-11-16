const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || '';
const targetIsWindows = target ? target.includes('windows') : process.platform === 'win32';
const executable = targetIsWindows ? 'ramppulse-server.exe' : 'ramppulse-server';
const args = ['build', '--release', '--manifest-path', path.join(root, 'rust-server', 'Cargo.toml')];
if (target) args.push('--target', target);

const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const buildDir = target
  ? path.join(root, 'rust-server', 'target', target, 'release')
  : path.join(root, 'rust-server', 'target', 'release');
const source = path.join(buildDir, executable);
const destinationDir = path.join(root, 'src-tauri', 'resources', 'server');
const destination = path.join(destinationDir, executable);
if (!fs.existsSync(source)) throw new Error(`Rust service build output is missing: ${source}`);
fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);
if (!targetIsWindows) fs.chmodSync(destination, 0o755);
for (const legacyName of ['airport-crm-server', 'airport-crm-server.exe']) {
  const legacy = path.join(destinationDir, legacyName);
  if (fs.existsSync(legacy)) fs.rmSync(legacy);
}
process.stdout.write(`Embedded Rust service: ${destination}\n`);
