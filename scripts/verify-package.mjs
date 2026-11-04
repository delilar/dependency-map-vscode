import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Use the ZIP reader already installed by the packaging tool.
const require = createRequire(import.meta.url);
const { open } = createRequire(require.resolve('@vscode/vsce/package.json'))('yauzl');
const sourceFiles = new Map([
  ['extension/package.json', 'package.json'], ['extension/readme.md', 'README.md'],
  ['extension/LICENSE.txt', 'LICENSE'], ['extension/SECURITY.md', 'SECURITY.md'],
  ['extension/THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['extension/schemas/dependency-map.schema.json', 'schemas/dependency-map.schema.json'],
  ...['extension.cjs', 'worker.cjs', 'webview.js', 'styles.css', 'build-info.json', 'parsers/astro.wasm', 'parsers/astro/index.cjs']
    .map(file => [`extension/dist/${file}`, `dist/${file}`]),
]);
const generatedFiles = new Set(['extension.vsixmanifest', '[Content_Types].xml']);
const hash = data => createHash('sha256').update(data).digest('hex');

export async function verifyPackage(packageFile, project = process.cwd()) {
  const expected = new Map(await Promise.all([...sourceFiles].map(async ([name, file]) => [name, await readFile(path.join(project, file))])));
  const zip = await new Promise((resolve, reject) => open(packageFile, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const entries = await new Promise((resolve, reject) => {
    const files = new Map();
    const fail = error => { zip.close(); reject(error); };
    zip.once('error', fail);
    zip.once('end', () => resolve(files));
    zip.on('entry', entry => {
      try {
        assert(expected.has(entry.fileName) || generatedFiles.has(entry.fileName), `Unexpected VSIX file: ${entry.fileName}`);
        assert(!files.has(entry.fileName), `Duplicate VSIX file: ${entry.fileName}`);
        const limit = entry.fileName === 'extension/package.json' || generatedFiles.has(entry.fileName) ? 1024 * 1024 : expected.get(entry.fileName).length;
        assert(entry.uncompressedSize > 0 && entry.uncompressedSize <= limit, `Invalid VSIX file size: ${entry.fileName}`);
        zip.openReadStream(entry, (error, stream) => {
          if (error) { fail(error); return; }
          (async () => {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry();
          })().catch(fail);
        });
      } catch (error) { fail(error); }
    });
    zip.readEntry();
  });
  assert.equal(entries.size, sourceFiles.size + generatedFiles.size, 'Required VSIX files are missing');
  for (const name of generatedFiles) assert(entries.has(name), `Required VSIX file is missing: ${name}`);
  const manifest = JSON.parse(entries.get('extension/package.json'));
  const current = JSON.parse(expected.get('extension/package.json'));
  for (const key of ['name', 'publisher', 'version', 'main']) assert.equal(manifest[key], current[key], `Stale VSIX manifest: ${key}`);
  for (const [name, data] of expected) if (name !== 'extension/package.json') {
    assert(entries.get(name)?.equals(data), `Stale packaged file: ${name}`);
  }
  const build = JSON.parse(entries.get('extension/dist/build-info.json'));
  assert.equal(build.extensionVersion, manifest.version, 'Build and manifest versions differ');
  const data = await readFile(packageFile);
  return { version: manifest.version, buildId: build.buildId, protocolVersion: build.protocolVersion, bytes: data.length, sha256: hash(data), files: entries.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = process.cwd();
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  const packageFile = path.resolve(process.argv[2] ?? `${manifest.name}-${manifest.version}.vsix`);
  const result = await verifyPackage(packageFile, project);
  await writeFile(`${packageFile}.sha256`, `${result.sha256}  ${path.basename(packageFile)}\n`);
  console.log(JSON.stringify(result));
}
