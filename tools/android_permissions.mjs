import fs from 'node:fs';

const manifestPath = 'src-tauri/gen/android/app/src/main/AndroidManifest.xml';
if (!fs.existsSync(manifestPath)) {
  throw new Error('Android-проект не создан. Сначала выполните: npm run android:prepare');
}

let manifest = fs.readFileSync(manifestPath, 'utf8');
const permissions = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
];
const missing = permissions.filter(name => !manifest.includes(`android:name="${name}"`));
if (missing.length) {
  const permissionXml = missing.map(name => `    <uses-permission android:name="${name}" />`).join('\n');
  manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n${permissionXml}`);
}
if (!manifest.includes('android.hardware.microphone')) {
  manifest = manifest.replace(
    /(<manifest\b[^>]*>[\s\S]*?)(\s*<application\b)/,
    '$1\n    <uses-feature android:name="android.hardware.microphone" android:required="false" />$2',
  );
}
fs.writeFileSync(manifestPath, manifest);
console.log('Android microphone permissions configured.');
