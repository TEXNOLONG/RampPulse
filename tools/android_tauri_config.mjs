import fs from 'node:fs';

const csp = [
  "default-src 'self' data: blob:",
  "img-src 'self' https: data: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "script-src 'self' 'unsafe-inline'",
  "font-src 'self' https: data:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https: wss: stun: turn: turns:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const config = {
  productName: 'RampPulse', version: packageJson.version, identifier: 'ru.oto.airport-crm',
  bundle: { resources: [] },
  app: {
    windows: [{ label: 'main', create: false, url: 'index.html', title: 'RampPulse', width: 412, height: 915, resizable: true, fullscreen: false, decorations: false, transparent: false, center: true, backgroundColor: '#09090B' }],
    security: { csp },
  },
};
fs.writeFileSync('src-tauri/tauri.android.conf.json', `${JSON.stringify(config, null, 2)}\n`);
console.log('Android config uses the bundled client and asks for the HTTPS API address in the app.');
