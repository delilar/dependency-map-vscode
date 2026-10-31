import { build } from 'esbuild';
import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = createHash('sha256');
async function hashSource(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await hashSource(file);
    else { hash.update(file.replace(/\\/g, '/')); hash.update(await readFile(file)); }
  }
}
await hashSource('src');
for (const file of ['package.json', 'package-lock.json', 'scripts/build.mjs']) hash.update(await readFile(file));
const buildInfo = { extensionVersion: JSON.parse(await readFile('package.json', 'utf8')).version, buildId: hash.digest('hex').slice(0, 20), protocolVersion: 2, capabilities: ['queries', 'branches', 'git', 'taskContexts', 'diagnostics'] };
const define = { __DEPENDENCY_MAP_BUILD__: JSON.stringify(buildInfo) };
await mkdir('dist', { recursive: true });
const results = [];
results.push(await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'], sourcemap: true, metafile: true, define }));
results.push(await build({ entryPoints: ['src/analysis/worker.ts'], outfile: 'dist/worker.cjs', bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: true, metafile: true, keepNames: true, define }));
results.push(await build({ entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', target: 'es2022', format: 'iife', sourcemap: true, metafile: true, define }));
await writeFile('dist/build-info.json', JSON.stringify(buildInfo, null, 2) + '\n');
await copyFile('src/webview/styles.css', 'dist/styles.css');
const packages = new Set();
for (const result of results) for (const input of Object.keys(result.metafile.inputs)) {
  const marker = input.lastIndexOf('node_modules/');
  if (marker < 0) continue;
  const start = marker + 'node_modules/'.length;
  const parts = input.slice(start).split('/');
  packages.add(input.slice(0, start) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/'));
}
const notices = ['# Bundled third-party software', '', 'The following packages are bundled into this extension. Their license texts follow.'];
for (const directory of [...packages].sort()) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenses = (await readdir(directory)).filter(name => /^licen[cs]e(?:\.|$)/i.test(name));
  if (!licenses.length) throw new Error(`Missing license text: ${metadata.name}`);
  notices.push('', `## ${metadata.name} ${metadata.version}`, '');
  for (const license of licenses) notices.push(await readFile(path.join(directory, license), 'utf8'));
}
await writeFile('THIRD_PARTY_NOTICES.md', notices.join('\n'));
