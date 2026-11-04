import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyPackage } from './verify-package.mjs';
const require = createRequire(import.meta.url);
const { ZipFile } = createRequire(require.resolve('@vscode/vsce/package.json'))('yazl');

test('VSIX gate accepts complete payload and rejects extra sources, stale bundles and missing WASM', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dependency-map-package-'));
  try {
    const files = new Map([
      ['package.json', JSON.stringify({ name: 'fixture', publisher: 'test', version: '0.2.1', main: './dist/extension.cjs' })],
      ['README.md', 'readme'], ['LICENSE', 'license'], ['SECURITY.md', 'security'], ['THIRD_PARTY_NOTICES.md', 'notices'],
      ['schemas/dependency-map.schema.json', '{}'],
      ...['extension.cjs', 'worker.cjs', 'webview.js', 'styles.css', 'parsers/astro.wasm', 'parsers/astro/index.cjs'].map(file => [`dist/${file}`, file]),
      ['dist/build-info.json', JSON.stringify({ extensionVersion: '0.2.1', buildId: 'test-build', protocolVersion: 3 })],
    ]);
    for (const [name, data] of files) { await mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await writeFile(path.join(directory, name), data); }
    async function archive(changes = {}) {
      const zip = new ZipFile();
      for (const [file, data] of files) {
        const name = `extension/${file === 'README.md' ? 'readme.md' : file === 'LICENSE' ? 'LICENSE.txt' : file}`;
        if (changes.omit === name) continue;
        zip.addBuffer(Buffer.from(changes.stale === name ? 'obsolete' : data), name);
      }
      for (const name of ['extension.vsixmanifest', '[Content_Types].xml', ...(changes.extra ? [changes.extra] : [])]) zip.addBuffer(Buffer.from('<xml/>'), name);
      const destination = path.join(directory, `${Date.now()}-${Math.random()}.vsix`);
      zip.end(); await pipeline(zip.outputStream, createWriteStream(destination)); return destination;
    }
    const accepted = await verifyPackage(await archive(), directory);
    assert.equal(accepted.files, 15); assert.equal(accepted.version, '0.2.1'); assert.match(accepted.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(verifyPackage(await archive({ extra: 'extension/src/private.ts' }), directory), /Unexpected VSIX file/);
    await assert.rejects(verifyPackage(await archive({ stale: 'extension/dist/worker.cjs' }), directory), /Stale packaged file|Invalid VSIX file size/);
    await assert.rejects(verifyPackage(await archive({ omit: 'extension/dist/parsers/astro.wasm' }), directory), /Required VSIX files are missing/);
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-package-'));
    await rm(directory, { recursive: true, force: true });
  }
});
