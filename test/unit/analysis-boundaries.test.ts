import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace, AnalyzerSession, WorkspaceFiles } from '../../src/analysis/index';

test('source analysis never probes .git or node_modules even without configured exclusions and with overlays', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-boundaries-'));
  const entries = {
    'entry.ts': 'import { secret } from "./.git/private"; import { pkg } from "./node_modules/pkg"; export const value = 1;',
    '.git/private.ts': 'export const secret = "PRIVATE_GIT_MARKER";',
    'node_modules/pkg/index.ts': 'export const pkg = "PRIVATE_MODULE_MARKER";',
    'tsconfig.json': '{"extends":"./.git/config.json"}',
    '.git/config.json': '{}'
  };
  for (const [relative, text] of Object.entries(entries)) {
    const target = path.join(directory, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
  }
  const originals = new Map<string, Function>();
  const probes: string[] = [];
  const forbidden = (value: unknown) => String(value).replace(/\\/g, '/').split('/').some(segment => ['.git', 'node_modules'].includes(segment.toLowerCase()));
  try {
    for (const method of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync'] as const) {
      const original = fs[method] as Function; originals.set(method, original);
      const wrapped = (...args: unknown[]) => { if (forbidden(args[0])) probes.push(`${method}:${args[0]}`); return original.apply(fs, args); };
      if (method === 'realpathSync') (wrapped as any).native = (...args: unknown[]) => {
        if (forbidden(args[0])) probes.push(`realpathSync.native:${args[0]}`);
        return (original as typeof fs.realpathSync).native.apply(fs, args as [fs.PathLike]);
      };
      (fs as any)[method] = wrapped;
    }
    const roots = [{ id: 'root', name: 'fixture', path: directory }];
    const overlays = [{ path: path.join(directory, '.git/overlay.ts'), version: 1, text: 'PRIVATE_GIT_MARKER' }];
    const graph = await analyzeWorkspace(roots, { exclude: [] }, overlays);
    const inventory = new WorkspaceFiles(roots, [], overlays); inventory.scan();
    assert(!inventory.allowed(path.join(directory, '.GIT/private.ts')));
    assert(!inventory.allowed(path.join(directory, 'NODE_MODULES/pkg')));
    assert.deepEqual(probes, []);
    assert(!graph.nodes.some(node => node.file?.path.split('/').includes('.git')));
    assert(!JSON.stringify(graph).includes('PRIVATE_GIT_MARKER'));
    assert(!JSON.stringify(graph).includes('PRIVATE_MODULE_MARKER'));
  } finally {
    for (const [method, original] of originals) (fs as any)[method] = original;
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-boundaries-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('coverage distinguishes parsed, node-only, unreadable and oversized files and matches a full rebuild', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-coverage-'));
  const roots = [{ id: 'root', name: 'fixture', path: directory }];
  const originalRead = fs.readFileSync;
  try {
    fs.writeFileSync(path.join(directory, 'entry.ts'), 'export const foo = 1;');
    fs.writeFileSync(path.join(directory, 'view.vue'), '<script>import hidden from "./unknown";</script>');
    fs.writeFileSync(path.join(directory, 'picture.png'), 'binary fixture');
    fs.writeFileSync(path.join(directory, 'unreadable.ts'), 'export const unavailable = 1;');
    fs.writeFileSync(path.join(directory, '.env.local'), `SECRET=${'PRIVATE_ENV_MARKER'.repeat(150000)}`);
    (fs as any).readFileSync = (...args: unknown[]) => {
      if (path.basename(String(args[0])) === 'unreadable.ts') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return originalRead.apply(fs, args as any);
    };
    const session = new AnalyzerSession();
    let graph = await session.analyze(roots, { exclude: [] }, []);
    const coverage = (name: string) => graph.coverage?.find(item => item.fileId === graph.nodes.find(node => node.file?.path === name)?.id);
    assert.equal(coverage('entry.ts')?.status, 'parsed');
    assert.equal(coverage('view.vue')?.status, 'parsed');
    assert(coverage('view.vue')?.reasonCodes.includes('unresolvedReference'));
    assert.equal(coverage('picture.png')?.status, 'nodeOnly');
    assert.equal(coverage('unreadable.ts')?.status, 'failed');
    assert(coverage('unreadable.ts')?.reasonCodes.includes('readFailed'));
    assert.equal(coverage('.env.local')?.status, 'skipped');
    assert(coverage('.env.local')?.reasonCodes.includes('textLimit'));
    assert(!JSON.stringify(graph).includes('PRIVATE_ENV_MARKER'));
    const overlayPath = path.join(directory, 'unsaved.ts');
    graph = await session.analyze(roots, { exclude: [] }, [{ path: overlayPath, version: 1, text: 'export const newFile = 1;' }], undefined, []);
    const unsaved = graph.nodes.find(node => node.file?.path === 'unsaved.ts')!;
    assert(unsaved);
    assert(!graph.physicalFileIds?.includes(unsaved.id));
    assert(graph.physicalFileIds?.includes(graph.nodes.find(node => node.file?.path === 'entry.ts')!.id));
    const fresh = await analyzeWorkspace(roots, { exclude: [] }, [{ path: overlayPath, version: 1, text: 'export const newFile = 1;' }]);
    assert.deepEqual(graph.coverage, fresh.coverage);
    assert.deepEqual(graph.exports, fresh.exports);
    assert.deepEqual(graph.bindingOccurrences, fresh.bindingOccurrences);
    assert.deepEqual(graph.physicalFileIds, fresh.physicalFileIds);
  } finally {
    fs.readFileSync = originalRead;
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-coverage-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an unreadable inventory is structured incompleteness, not a successful empty scope', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-inventory-'));
  const original = fs.readdirSync;
  try {
    fs.writeFileSync(path.join(directory, 'entry.ts'), 'export const x = 1;');
    (fs as any).readdirSync = (...args: unknown[]) => {
      if (String(args[0]).toLowerCase() === directory.toLowerCase()) throw new Error('PRIVATE_PATH_MARKER should not escape');
      return original.apply(fs, args as any);
    };
    const graph = await analyzeWorkspace([{ id: 'root', name: 'fixture', path: directory }], { exclude: [] }, []);
    assert.deepEqual(graph.coverageReasons, ['inventoryReadFailed']);
    assert.deepEqual(graph.nodes, []);
    assert(!JSON.stringify(graph).includes('PRIVATE_PATH_MARKER'));
  } finally {
    fs.readdirSync = original;
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-inventory-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
