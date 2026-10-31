import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const files = (await readdir('test/unit')).filter(name => name.endsWith('.test.ts')).map(name => `test/unit/${name}`);
if (!files.length) throw new Error('No unit tests found');
await mkdir('.test-dist', { recursive: true });
await build({ entryPoints: files, outdir: '.test-dist', bundle: true, platform: 'node', target: 'node18', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['vscode'], keepNames: true });
// Windows CI can expose a short-name TEMP path that fails physical workspace containment checks.
const temp = realpathSync.native(tmpdir());
const result = spawnSync(process.execPath, ['--test', ...files.map(file => `.test-dist/${file.split('/').pop().replace(/\.ts$/, '.cjs')}`)], { stdio: 'inherit', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp } });
process.exit(result.status ?? 1);
