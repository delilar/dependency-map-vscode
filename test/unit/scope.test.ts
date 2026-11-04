import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyGraph, fileId, initialView, relationId, type GraphSnapshot } from '../../src/shared/model';
import { inScope, isScopeSpec, normalizeScope, scopedGraph, scopeSignature, type ScopeSpec } from '../../src/shared/scope';
import { isQueryRequest, queryLimits, type QueryRequest, type QuerySpec } from '../../src/shared/query-model';
import { GraphQueryIndex } from '../../src/analysis/graph-query-index';
import { executeQuery } from '../../src/analysis/graph-queries';
import { exportTables, resolveExport } from '../../src/analysis/export-resolution';
import { projectGraph } from '../../src/webview/graph';
import { QueryCoordinator } from '../../src/host/query-coordinator';
import { LocalTaskContextStore, taskContextStoreKey } from '../../src/host/task-contexts';

const id = (path: string, rootId = 'r') => fileId({ rootId, path });
const scope: ScopeSpec = { version: 1, folders: [{ rootId: 'r', path: 'feature' }], excludeRoles: [] };
function fixture(): GraphSnapshot {
  const graph = emptyGraph();
  graph.nodes = ['feature/A.ts', 'shared/B.ts', 'feature/C.ts', 'tests/A.test.ts'].map(path => ({ id: id(path), kind: 'file', file: { rootId: 'r', path }, label: path, format: '.ts', projectId: 'p', role: path.includes('.test.') ? 'test' : 'source' }));
  graph.relations = [['feature/A.ts', 'shared/B.ts'], ['shared/B.ts', 'feature/C.ts'], ['tests/A.test.ts', 'feature/A.ts']].map(([source, target]) => ({ id: relationId(id(source), id(target), 'import'), sourceId: id(source), targetId: id(target), kind: 'import', certainty: 'confirmed', bindings: [], evidence: [{ rule: 'fixture' }] }));
  graph.coverage = graph.nodes.map(node => ({ fileId: node.id, status: 'parsed', reasonCodes: [], unresolvedCount: 0, symbols: 'available' }));
  return graph;
}
const request = (query: QuerySpec, spec?: ScopeSpec): QueryRequest => ({ type: 'query', apiVersion: 1, requestId: 'q', graph: { epoch: 'e', revision: 0, scopeRevision: 0 }, query, scope: spec, queryScopeSignature: scopeSignature(spec), limits: queryLimits });

test('scope validates portable boundaries, canonicalizes unions and distinguishes roots', () => {
  assert(isScopeSpec(scope));
  for (const path of ['', '..', '../feature', '/feature', 'C:/feature', 'feature/../shared', 'node_modules/x', 'feature\\x']) assert(!isScopeSpec({ ...scope, folders: [{ rootId: 'r', path }] }));
  assert(!isScopeSpec({ ...scope, folders: [] }));
  assert(!isScopeSpec({ ...scope, excludeRoles: ['made-up'] }));
  assert(!isScopeSpec({ ...scope, excludeRoles: ['__proto__'] }));
  const normalized = normalizeScope({ version: 1, folders: [...scope.folders, { rootId: 'r', path: 'feature/nested' }, ...scope.folders], excludeRoles: ['test', 'mock', 'test'] });
  assert.deepEqual(normalized, { ...scope, excludeRoles: ['mock', 'test'] });
  const graph = fixture(), a = graph.nodes[0];
  assert(inScope(a, scope)); assert(!inScope({ ...a, file: { rootId: 'r', path: 'feature-old/A.ts' } }, scope));
  assert(!inScope({ ...a, file: { rootId: 'other', path: 'feature/A.ts' } }, scope));
  assert(isQueryRequest(request({ kind: 'path', fromId: a.id, toId: a.id }, scope)));
  assert(!isQueryRequest({ ...request({ kind: 'path', fromId: a.id, toId: a.id }, scope), queryScopeSignature: 'all' }));
});

test('V keeps hidden intermediary reachable; Q prunes it for queries, Explore, forced IDs and branches', async () => {
  const graph = fixture(), index = new GraphQueryIndex(graph);
  const query: QuerySpec = { kind: 'path', fromId: id('feature/A.ts'), toId: id('feature/C.ts') };
  const full = await executeQuery(index, request(query));
  assert.equal(full.outcome, 'found'); assert.deepEqual(full.nodeIds, [id('feature/A.ts'), id('shared/B.ts'), id('feature/C.ts')]);
  const strict = await executeQuery(index, request(query, scope));
  assert.equal(strict.outcome, 'notFoundWithinScope'); assert.deepEqual(strict.relationIds, []);
  const view = { ...initialView(), focusId: id('feature/A.ts'), depth: 3 };
  const visible = projectGraph(graph, { ...view, presentationScope: scope }, { direction: 'outgoing' });
  assert.deepEqual(visible.nodes.map(node => node.id), [id('feature/A.ts'), id('feature/C.ts')]);
  const scoped = projectGraph(graph, { ...view, queryScope: scope }, { direction: 'outgoing', forcedIds: new Set([id('shared/B.ts')]) });
  assert.deepEqual(scoped.nodes.map(node => node.id), [id('feature/A.ts')]);
  assert.equal(scoped.edges.length, 0);
});

test('incoming coverage is restricted to permitted possible source files, not only visited files', async () => {
  const graph = fixture(); graph.coverage![1].reasonCodes.push('unsupportedInternalReferences');
  const query: QuerySpec = { kind: 'impact', seeds: [id('feature/C.ts')], depth: 5, includeInferred: false, includeTypes: true };
  assert.equal((await executeQuery(new GraphQueryIndex(graph), request(query))).coverage, 'partial');
  assert.equal((await executeQuery(new GraphQueryIndex(graph), request(query, scope))).coverage, 'complete');
  graph.coverage![0].reasonCodes.push('unsupportedInternalReferences');
  assert.equal((await executeQuery(new GraphQueryIndex(graph), request(query, scope))).coverage, 'partial');
});

test('scoped symbol resolution never reuses a full-index barrel cache or precomputed declaration', async () => {
  const graph = fixture(), [a, b, c] = graph.nodes;
  graph.relations[0].kind = 'reexport'; graph.relations[1].kind = 'reexport';
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  graph.exports = [
    { fileId: a.id, name: 'foo', namespace: 'value', kind: 'forward', forwarded: { relationId: graph.relations[0].id, imported: 'foo' } },
    { fileId: b.id, name: 'foo', namespace: 'value', kind: 'forward', forwarded: { relationId: graph.relations[1].id, imported: 'foo' } },
    { fileId: c.id, name: 'foo', namespace: 'value', kind: 'direct', range },
  ];
  graph.declarations = [{ relationId: graph.relations[0].id, imported: 'foo', file: c.file!, range }];
  const index = new GraphQueryIndex(graph);
  assert.equal(resolveExport(index.symbols, a.id, 'foo', 'value').status, 'resolved');
  const query: QuerySpec = { kind: 'symbol', fileId: a.id, exported: 'foo', namespace: 'value' };
  const result = await executeQuery(index, request(query, scope));
  assert(result.kind === 'symbol'); assert.notEqual(result.resolution.status, 'resolved');
  assert(!result.nodeIds.includes(b.id)); assert.equal(scopedGraph(graph, scope).declarations?.length, 0);
  assert.equal(resolveExport(exportTables(graph), a.id, 'foo', 'value').status, 'resolved');
});

test('all-edge Path is explicit and inferred edges remain separately opt-in; Impact default is unchanged', async () => {
  const graph = fixture(); graph.relations[0].kind = 'resource'; graph.relations[1].certainty = 'inferred';
  const query = { kind: 'path' as const, fromId: id('feature/A.ts'), toId: id('feature/C.ts') };
  assert.equal((await executeQuery(new GraphQueryIndex(graph), request(query))).outcome, 'notFoundWithinScope');
  assert.equal((await executeQuery(new GraphQueryIndex(graph), request({ ...query, mode: 'all' }))).outcome, 'notFoundWithinScope');
  assert.equal((await executeQuery(new GraphQueryIndex(graph), request({ ...query, mode: 'all', includeInferred: true }))).outcome, 'found');
});

test('scope signature fences late replies and seeds outside Q without changing index revision', async () => {
  const graph = fixture(), coordinator = new QueryCoordinator();
  const index = { version: { epoch: 'e', revision: 0, scopeRevision: 0 }, state: 'ready' as const, reasonCodes: [] };
  const query: QuerySpec = { kind: 'path', fromId: id('feature/A.ts'), toId: id('feature/A.ts') };
  const pending = coordinator.start(query, index, graph, undefined, scope)!;
  const result = await executeQuery(new GraphQueryIndex(graph), pending);
  assert(!coordinator.accept(result, index)); assert(coordinator.accept(result, index, undefined, scope));
  assert(!coordinator.start({ kind: 'path', fromId: id('shared/B.ts'), toId: id('feature/A.ts') }, index, graph, undefined, scope));
});

test('v2 local contexts read legacy state, write only v2 and preserve dormant root selectors', async () => {
  const values = new Map<string, unknown>();
  const memory = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); } };
  const legacy = { version: 1, contexts: [] }; values.set('dependencyMap.taskContexts.v1', legacy);
  const store = new LocalTaskContextStore(memory);
  await store.save('r:.vscode/dependency-map.json', 'task', { view: { ...initialView(), queryScope: scope }, ui: {}, branches: [], selection: { nodeIds: [], relationIds: [] } }, 'fingerprint');
  assert.deepEqual(values.get('dependencyMap.taskContexts.v1'), legacy);
  assert(values.has(taskContextStoreKey)); assert.equal(taskContextStoreKey, 'dependencyMap.taskContexts.v2');
  assert.deepEqual(store.load('r:.vscode/dependency-map.json', 'task')?.data.view.queryScope, scope);
});
