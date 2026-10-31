import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace } from '../../src/analysis/index';
import { exportTables, resolveExport } from '../../src/analysis/export-resolution';

test('CommonJS defineProperty in a star branch cannot prove a unique ESM export origin', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'dependency-map-export-review-'));
  try {
    fs.writeFileSync(path.join(directory, 'a.mjs'), 'export const foo = 1;');
    fs.writeFileSync(path.join(directory, 'common.cjs'), 'Object.defineProperty(exports, "foo", { enumerable: true, value: 2 });');
    fs.writeFileSync(path.join(directory, 'barrel.mjs'), 'export * from "./a.mjs"; export * from "./common.cjs";');
    const graph = await analyzeWorkspace([{ id: 'review', name: 'review', path: directory }], { exclude: [] }, []);
    const barrel = graph.nodes.find(node => node.file?.path === 'barrel.mjs')!;
    const result = resolveExport(exportTables(graph), barrel.id, 'foo', 'value');
    assert.notEqual(result.status, 'resolved', 'Unknown CommonJS branch is not proof that the ESM origin is unique.');
    assert(result.reasonCodes.includes('unsupportedCommonJs') || result.reasonCodes.includes('partialExportResolution'));
  } finally {
    const target = path.resolve(directory), relative = path.relative(fs.realpathSync.native(os.tmpdir()), target);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(target).startsWith('dependency-map-export-review-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('an unsupported explicit local namespace export still shadows a star export of the same name', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'dependency-map-export-review-'));
  try {
    fs.writeFileSync(path.join(directory, 'a.ts'), 'export const Foo = 1;');
    fs.writeFileSync(path.join(directory, 'barrel.ts'), 'export * from "./a"; namespace Foo { export const member = 2; } export { Foo };');
    const graph = await analyzeWorkspace([{ id: 'review', name: 'review', path: directory }], { exclude: [] }, []);
    const barrel = graph.nodes.find(node => node.file?.path === 'barrel.ts')!;
    const result = resolveExport(exportTables(graph), barrel.id, 'Foo', 'value');
    assert.notEqual(result.status, 'resolved', 'Explicit unsupported Foo must not silently resolve to another Foo through export-star.');
    assert.notEqual(result.candidates[0]?.fileId, graph.nodes.find(node => node.file?.path === 'a.ts')?.id);
  } finally {
    const target = path.resolve(directory), relative = path.relative(fs.realpathSync.native(os.tmpdir()), target);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(target).startsWith('dependency-map-export-review-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
});
