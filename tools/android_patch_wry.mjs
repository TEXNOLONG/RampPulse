import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'src-tauri');
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version=1', '--manifest-path', path.join(tauri, 'Cargo.toml')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const wry = metadata.packages.find(pkg => pkg.name === 'wry' && pkg.source?.includes('b307d51'));
if (!wry) throw new Error('Pinned Wry Android crash fix is missing from Cargo metadata.');

const generated = path.join(tauri, 'gen', 'android', 'app', 'src', 'main', 'java');
const rustKotlin = path.join(generated, 'ru', 'oto', 'airport_crm', 'generated', 'Rust.kt');
if (!existsSync(rustKotlin)) throw new Error('Android project is not generated; run android:prepare first.');
const rustSource = readFileSync(rustKotlin, 'utf8');
const packageName = rustSource.match(/^package\s+([\w.]+)$/m)?.[1];
if (!packageName) throw new Error('Could not read generated Android package name.');

const packagePath = packageName.replaceAll('.', path.sep);
const outputDir = path.join(generated, packagePath, 'generated');
const templateDir = path.join(path.dirname(wry.manifest_path), 'src', 'android', 'kotlin');
const templates = [
  ['RustWebView.kt', { '{{package}}': packageName, '{{class-init}}': '', '{{class-extension}}': '' }],
  ['RustWebViewClient.kt', { '{{package}}': packageName, '{{class-extension}}': '' }],
  ['proguard-wry.pro', { '{{package-unescaped}}': packageName }],
];

for (const [filename, substitutions] of templates) {
  let content = readFileSync(path.join(templateDir, filename), 'utf8');
  for (const [token, value] of Object.entries(substitutions)) content = content.replaceAll(token, value);
  if (/\{\{[^}]+\}\}/.test(content)) throw new Error(`Unresolved Wry template token in ${filename}.`);
  writeFileSync(path.join(outputDir, filename), content);
}

const webView = readFileSync(path.join(outputDir, 'RustWebView.kt'), 'utf8');
if (!webView.includes('fun urlFromAnyThread()') || !webView.includes('recordNavigationState()')) {
  throw new Error('Generated Android WebView does not include the Wry getter-timeout fix.');
}
console.log('Applied the pinned Wry Android WebView getter fix to generated sources.');
