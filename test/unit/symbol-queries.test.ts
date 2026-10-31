import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AnalyzerSession, analyzeWorkspace } from '../../src/analysis/index';
import { GraphQueryIndex } from '../../src/analysis/graph-query-index';
import { executeQuery } from '../../src/analysis/graph-queries';
import { exportTables, resolveExport } from '../../src/analysis/export-resolution';
import { queryLimits, type QuerySpec, type SymbolNamespace } from '../../src/shared/query-model';
import { fileId, type GraphSnapshot } from '../../src/shared/model';

const id = (name: string) => fileId({ rootId: 'root', path: name });
async function fixture(entries: Record<string, string>, run: (graph: GraphSnapshot, directory: string) => Promise<void> | void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-symbols-'));
  try {
    for (const [name, text] of Object.entries(entries)) fs.writeFileSync(path.join(directory, name), text);
    await run(await analyzeWorkspace([{ id: 'root', name: 'fixture', path: directory }], { exclude: [] }, []), directory);
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-symbols-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const request = (file: string, exported: string, namespace: SymbolNamespace = 'value', limits = {}) => ({ type: 'query' as const, apiVersion: 1 as const, requestId: 'symbols', graph: { epoch: 'fixture', revision: 1, scopeRevision: 1 }, query: { kind: 'symbol', fileId: id(file), exported, namespace } satisfies QuerySpec, limits: { ...queryLimits, ...limits } });

test('symbol focus follows explicit aliases and reexports without attributing all imports to arbitrary exported functions', async () => {
  await fixture({
    'origin.ts': 'export const foo = 1; export const bar = 2; export interface Shape { x: number }',
    'barrel.ts': 'export { foo as feature, type Shape } from "./origin";',
    'consumer.ts': 'import { feature as localFeature, type Shape } from "./barrel";',
    'bar-only.ts': 'import { bar } from "./origin";',
    'other.ts': 'export const foo = 3;',
    'other-consumer.ts': 'import { foo } from "./other";',
    'wrapper.ts': 'import { foo } from "./origin"; export function arbitrary() { return foo; }',
    'wrapper-consumer.ts': 'import { arbitrary } from "./wrapper";'
  }, async graph => {
    const result = await executeQuery(new GraphQueryIndex(graph), request('origin.ts', 'foo'));
    assert.equal(result.kind, 'symbol'); if (result.kind !== 'symbol') return;
    assert.equal(result.outcome, 'resolved');
    assert(result.nodeIds.includes(id('barrel.ts'))); assert(result.nodeIds.includes(id('consumer.ts'))); assert(result.nodeIds.includes(id('wrapper.ts')));
    for (const absent of ['bar-only.ts', 'other.ts', 'other-consumer.ts', 'wrapper-consumer.ts']) assert(!result.nodeIds.includes(id(absent)), absent);
    const alias = graph.bindingOccurrences?.find(row => row.local === 'localFeature');
    assert.equal(alias?.imported, 'feature'); assert(alias?.range);
    assert.equal(graph.exports?.find(entry => entry.fileId === id('origin.ts') && entry.name === 'Shape')?.namespace, 'type');
    const typeFocus = await executeQuery(new GraphQueryIndex(graph), request('origin.ts', 'Shape', 'type'));
    assert(typeFocus.nodeIds.includes(id('consumer.ts')));
    assert(!typeFocus.nodeIds.includes(id('wrapper.ts')));
  });
});

test('star ambiguity and an unknown star branch never expose a falsely unique declaration', async () => {
  await fixture({
    'a.ts': 'export const foo = 1;', 'b.ts': 'export const foo = 2;',
    'ambiguous.ts': 'export * from "./a"; export * from "./b";',
    'partial.ts': 'export * from "./a"; export * from "./missing";',
    'consumer.ts': 'import { foo } from "./ambiguous";', 'partial-consumer.ts': 'import { foo } from "./partial";'
  }, async graph => {
    const tables = exportTables(graph);
    const ambiguous = resolveExport(tables, id('ambiguous.ts'), 'foo', 'value');
    assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.candidates.length, 2);
    const partial = resolveExport(tables, id('partial.ts'), 'foo', 'value');
    assert.equal(partial.status, 'unresolved'); assert.equal(partial.candidates.length, 1); assert(partial.reasonCodes.includes('missingModule'));
    for (const name of ['consumer.ts', 'partial-consumer.ts']) {
      const relation = graph.relations.find(edge => edge.sourceId === id(name))!;
      assert(!graph.declarations?.some(item => item.relationId === relation.id));
    }
    const focus = await executeQuery(new GraphQueryIndex(graph), request('a.ts', 'foo'));
    assert(!focus.nodeIds.includes(id('consumer.ts'))); assert(!focus.nodeIds.includes(id('partial-consumer.ts')));
    assert.equal(focus.coverage, 'partial'); assert(focus.reasonCodes.includes('ambiguousConsumerExport'));
    const ambiguousFocus = await executeQuery(new GraphQueryIndex(graph), request('ambiguous.ts', 'foo'));
    assert.equal(ambiguousFocus.outcome, 'ambiguous');
  });
});

test('same endpoint through two barrels is unique, explicit shadowing wins and default does not pass a star', async () => {
  await fixture({
    'a.ts': 'export const foo = 1; export default function Main() {}', 'b.ts': 'export const foo = 2;',
    'left.ts': 'export {foo} from "./a";', 'right.ts': 'export {foo} from "./a";',
    'merge.ts': 'export * from "./left"; export * from "./right";',
    'shadow.ts': 'export * from "./a"; export {foo} from "./b";',
    'stars.ts': 'export * from "./a";'
  }, graph => {
    const tables = exportTables(graph);
    const merged = resolveExport(tables, id('merge.ts'), 'foo', 'value');
    assert.equal(merged.status, 'resolved'); assert.equal(merged.candidates.length, 1); assert.equal(merged.candidates[0].fileId, id('a.ts'));
    assert.equal(merged.candidates[0].relationIds.length, 4);
    assert.equal(resolveExport(tables, id('shadow.ts'), 'foo', 'value').candidates[0].fileId, id('b.ts'));
    assert.equal(resolveExport(tables, id('stars.ts'), 'default', 'value').status, 'unresolved');
  });
});

test('cyclic stars with an exit resolve without infinite enumeration, namespace and CommonJS stay explicit', async () => {
  await fixture({
    'a.ts': 'export const foo = 1;',
    'cycle-a.ts': 'export * from "./cycle-b"; export * from "./a";',
    'cycle-b.ts': 'export * from "./cycle-a";',
    'namespace.ts': 'export * as tools from "./a";',
    'namespace-import.ts': 'import * as tools from "./a";',
    'common.cjs': 'module.exports = { foo: 1 };',
    'cjs-consumer.ts': 'import {foo} from "./common.cjs";'
  }, async graph => {
    const tables = exportTables(graph);
    assert.equal(resolveExport(tables, id('cycle-b.ts'), 'foo', 'value').status, 'resolved');
    assert.equal(resolveExport(tables, id('namespace.ts'), 'tools', 'value').status, 'unsupported');
    const cjs = resolveExport(tables, id('common.cjs'), 'foo', 'value');
    assert.equal(cjs.status, 'unsupported'); assert(cjs.reasonCodes.includes('unsupportedCommonJs'));
    const focus = await executeQuery(new GraphQueryIndex(graph), request('a.ts', 'foo'));
    assert(focus.nodeIds.includes(id('cycle-b.ts'))); assert(!focus.nodeIds.includes(id('namespace-import.ts')));
    assert(focus.reasonCodes.includes('namespaceImport'));
  });
});

test('symbol witnesses include every actual intermediate provenance node and respect small query budgets', async () => {
  await fixture({
    'a.ts': 'export const foo = 1;', 'b.ts': 'export {foo as bar} from "./a";',
    'c.ts': 'export {bar as baz} from "./b";', 'use.ts': 'import {foo} from "./a";'
  }, async graph => {
    const result = await executeQuery(new GraphQueryIndex(graph), request('c.ts', 'baz'));
    const witness = result.witnesses.find(path => path.nodeId === id('use.ts'))!;
    assert(witness); assert.deepEqual(witness.nodeIds, [id('c.ts'), id('b.ts'), id('a.ts'), id('use.ts')]);
    assert.equal(witness.nodeIds.length, witness.relationIds.length + 1);
    for (let i = 0; i < witness.relationIds.length; i++) {
      const edge = graph.relations.find(edge => edge.id === witness.relationIds[i])!;
      assert.deepEqual(new Set([edge.sourceId, edge.targetId]), new Set(witness.nodeIds.slice(i, i + 2)));
    }
    const limited = await executeQuery(new GraphQueryIndex(graph), request('c.ts', 'baz', 'value', { maxNodes: 1, maxRelations: 1 }));
    assert.equal(limited.coverage, 'partial'); assert(limited.reasonCodes.includes('nodeLimit') || limited.reasonCodes.includes('relationLimit'));
    assert(limited.visitedNodes <= 1); assert(limited.examinedRelations <= 1);
  });
});

test('incremental export removal cannot silently substitute another same-name export', async () => {
  await fixture({ 'a.ts': 'export const foo = 1;', 'b.ts': 'export const foo = 2;', 'use.ts': 'import {foo} from "./a";' }, async (graph, directory) => {
    const roots = [{ id: 'root', name: 'fixture', path: directory }];
    const session = new AnalyzerSession(); await session.analyze(roots, { exclude: [] }, []);
    fs.writeFileSync(path.join(directory, 'a.ts'), 'export const removed = 1;');
    const updated = await session.analyze(roots, { exclude: [] }, [], undefined, [path.join(directory, 'a.ts')]);
    const result = await executeQuery(new GraphQueryIndex(updated), request('a.ts', 'foo'));
    assert.equal(result.outcome, 'unresolved'); assert(!result.nodeIds.includes(id('b.ts')));
    const full = await analyzeWorkspace(roots, { exclude: [] }, []);
    assert.deepEqual(updated.exports, full.exports); assert.deepEqual(updated.bindingOccurrences, full.bindingOccurrences); assert.deepEqual(updated.coverage, full.coverage);
    assert(graph.exports?.some(entry => entry.fileId === id('a.ts') && entry.name === 'foo'));
  });
});

test('forwarded imported aliases use their actual import edge when the same module also has a different reexport', async () => {
  await fixture({
    'a.ts': 'export const foo = 1; export const bar = 2; export class Shape {}',
    'b.ts': 'import {foo} from "./a"; import type {Shape} from "./a"; export {foo as alias, Shape}; export {bar} from "./a";',
    'use.ts': 'import {alias} from "./b";'
  }, async graph => {
    const alias = graph.exports!.find(entry => entry.fileId === id('b.ts') && entry.name === 'alias')!;
    const proof = graph.relations.find(edge => edge.id === alias.forwarded?.relationId)!;
    assert.equal(proof.kind, 'import'); assert(proof.bindings.some(binding => binding.imported === 'foo'));
    assert.equal(graph.exports!.find(entry => entry.fileId === id('b.ts') && entry.name === 'Shape')?.namespace, 'type');
    const result = await executeQuery(new GraphQueryIndex(graph), request('a.ts', 'foo'));
    assert(result.nodeIds.includes(id('use.ts')));
    assert(!result.relationIds.some(id => graph.relations.find(edge => edge.id === id)?.kind === 'reexport' && graph.relations.find(edge => edge.id === id)?.bindings.every(binding => binding.imported === 'bar')));
  });
});

test('a module reexport is independent of same-named local type imports', async () => {
  await fixture({
    'types.ts': 'export interface Foo { value: number }',
    'values.ts': 'export const Foo = 1;',
    'barrel.ts': 'import type {Foo} from "./types"; export {Foo} from "./values";',
    'use.ts': 'import {Foo} from "./barrel";'
  }, async graph => {
    const result = await executeQuery(new GraphQueryIndex(graph), request('values.ts', 'Foo', 'value'));
    assert.equal(result.outcome, 'resolved'); assert(result.nodeIds.includes(id('use.ts')));
    const exported = graph.exports?.find(entry => entry.fileId === id('barrel.ts') && entry.name === 'Foo');
    assert.equal(exported?.namespace, 'both');
  });
});

test('star provenance cooperatively cancels after starting and reports hard node/relation limits', async () => {
  const graph: GraphSnapshot = { revision: 1, nodes: [], relations: [], unresolved: [], diagnostics: [], coverage: [], exports: [], bindingOccurrences: [], stats: { files: 301, relations: 300, elapsedMs: 0 } };
  for (let n = 0; n <= 300; n++) {
    const name = `${n}.ts`, file = fileId({ rootId: 'root', path: name });
    graph.nodes.push({ id: file, file: { rootId: 'root', path: name }, kind: 'file', format: '.ts', projectId: 'test', label: name });
    graph.coverage!.push({ fileId: file, status: 'parsed', reasonCodes: [], unresolvedCount: 0 });
    if (n) {
      const relationId = `star-${n}`;
      graph.relations.push({ id: relationId, sourceId: id('0.ts'), targetId: file, kind: 'reexport', certainty: 'confirmed', bindings: [{ imported: '*', typeOnly: false }], evidence: [{ rule: 'fixture star' }] });
      graph.exports!.push({ fileId: id('0.ts'), name: '*', namespace: 'both', kind: 'star', forwarded: { relationId, imported: '*' } });
      graph.exports!.push({ fileId: file, name: 'foo', namespace: 'value', kind: 'direct' });
    }
  }
  let cancelled = false;
  setImmediate(() => setImmediate(() => { cancelled = true; }));
  const result = await executeQuery(new GraphQueryIndex(graph), request('0.ts', 'foo'), () => cancelled);
  assert.equal(result.operation, 'cancelled'); assert(result.visitedNodes > 1); assert(result.visitedNodes < graph.nodes.length);
  const limited = await executeQuery(new GraphQueryIndex(graph), request('0.ts', 'foo', 'value', { maxNodes: 10, maxRelations: 10 }));
  assert.equal(limited.coverage, 'partial'); assert(limited.reasonCodes.includes('nodeLimit') || limited.reasonCodes.includes('relationLimit'));
  assert(limited.visitedNodes <= 10); assert(limited.examinedRelations <= 10);
});
