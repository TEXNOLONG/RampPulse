import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Pass Tauri arguments after the build helper.');
const result = spawnSync('npm', ['run', 'tauri', '--', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_RAMPULSE_CLIENT_ONLY: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
