import fs from 'node:fs';

const raw = process.env.RAMPULSE_SERVER_URL;
if (!raw) throw new Error('Задайте RAMPULSE_SERVER_URL — HTTPS-адрес Rust-сервера RampPulse.');
const server = new URL(raw);
if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) {
  throw new Error('RAMPULSE_SERVER_URL должен быть HTTPS URL без логина, пароля, query и hash.');
}
const origin = server.origin;
const socketOrigin = `wss://${server.host}`;
const csp = [
  `default-src 'self' ${origin} data: blob:`,
  `img-src 'self' ${origin} data: blob:`,
  `style-src 'self' 'unsafe-inline' ${origin}`,
  `script-src 'self' 'unsafe-inline' ${origin}`,
  `font-src 'self' ${origin} data:`,
  `media-src 'self' ${origin} blob:`,
  `connect-src 'self' ${origin} ${socketOrigin} stun: turn: turns:`,
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');
const config = {
  app: {
    windows: [{
      label: 'main',
      create: false,
      url: `${origin}/login`,
      title: 'RampPulse · Рабочее место инженера',
      width: 412,
      height: 915,
      resizable: true,
      fullscreen: false,
      decorations: false,
      transparent: false,
      center: true,
      backgroundColor: '#09090B',
    }],
    security: { csp },
  },
};
fs.writeFileSync('src-tauri/tauri.android.conf.json', `${JSON.stringify(config, null, 2)}\n`);
const capability = {
  identifier: 'rampulse-production-server',
  description: 'Allow native window close controls and Tauri events only from the configured RampPulse HTTPS server.',
  windows: ['main'],
  remote: { urls: [origin] },
  permissions: ['core:window:allow-close', 'core:event:allow-listen', 'allow-rampulse-backend'],
};
fs.writeFileSync('src-tauri/capabilities/remote-server.json', `${JSON.stringify(capability, null, 2)}\n`);
console.log(`Android CSP locked to ${origin} and ${socketOrigin}`);
