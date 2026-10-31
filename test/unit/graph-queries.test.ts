import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyGraph, fileId, relationId, type GraphSnapshot, type Relation } from '../../src/shared/model';
import { queryLimits, type QueryRequest, type QuerySpec } from '../../src/shared/query-model';
import { GraphQueryIndex } from '../../src/analysis/graph-query-index';
import { executeQuery } from '../../src/analysis/graph-queries';

const id = (name: string, rootId = 'root') => fileId({ rootId, path: name });
function fixture(names: string[], edges: [string, string, Partial<Relation>?][]): GraphSnapshot {
  const graph = emptyGraph(); graph.revision = 5;
  graph.nodes = names.map(name => ({ id: id(name), kind: 'file', file: { rootId: 'root', path: name }, label: name, format: '.ts', projectId: 'project', role: name.endsWith('.test.ts') ? 'test' : name.includes('mock') ? 'mock' : 'source' }));
  graph.relations = edges.map(([source, target, fields = {}]) => ({ id: relationId(id(source), id(target), fields.kind ?? 'import', fields.specifier ?? `./${target}`), sourceId: id(source), targetId: id(target), kind: 'import', certainty: 'confirmed', bindings: [], evidence: [{ rule: 'fixture import', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }], ...fields }));
  graph.coverage = graph.nodes.map(node => ({ fileId: node.id, status: 'parsed', reasonCodes: [], unresolvedCount: 0 })); graph.coverageReasons = [];
  return graph;
}
const request = (query: QuerySpec, limits = {}) => ({ type: 'query', apiVersion: 1, requestId: 'test', graph: { epoch: 'fixture', scopeRevision: 1, revision: 5 }, query, limits: { ...queryLimits, ...limits } } satisfies QueryRequest);

test('incoming impact preserves shortest witnesses, excludes cyclic seeds and separates tests from mocks', async () => {
  const graph = fixture(['A.ts', 'B.ts', 'C.ts', 'C.test.ts', 'C.mock.ts'], [['A.ts', 'B.ts'], ['B.ts', 'A.ts'], ['C.ts', 'A.ts'], ['C.test.ts', 'C.ts'], ['C.mock.ts', 'C.ts']]);
  const result = await executeQuery(new GraphQueryIndex(graph), request({ kind: 'impact', seeds: [id('B.ts')], depth: 20, includeInferred: false, includeTypes: true }));
  assert.equal(result.kind, 'impact'); if (result.kind !== 'impact') return;
  assert.deepEqual(result.directIds, [id('A.ts')]);
  assert.deepEqual(new Set(result.indirectIds), new Set([id('C.ts'), id('C.test.ts'), id('C.mock.ts')]));
  assert.deepEqual(result.testIds, [id('C.test.ts')]);
  assert.deepEqual(result.witnesses.find(path => path.nodeId === id('C.test.ts'))?.nodeIds, [id('B.ts'), id('A.ts'), id('C.ts'), id('C.test.ts')]);
  assert.equal(result.coverage, 'complete');
});

test('impact policy includes confirmed resources but distinguishes inferred and type-only relations', async () => {
  const graph = fixture(['asset.ts', 'style.ts', 'types.ts', 'inferred.ts'], [
    ['style.ts', 'asset.ts', { kind: 'resource' }], ['types.ts', 'asset.ts', { bindings: [{ imported: 'Foo', typeOnly: true }] }], ['inferred.ts', 'asset.ts', { certainty: 'inferred' }]
  ]);
  const result = await executeQuery(new GraphQueryIndex(graph), request({ kind: 'impact', seeds: [id('asset.ts')], depth: 20, includeInferred: false, includeTypes: false }));
  assert(result.kind === 'impact'); assert.deepEqual(result.directIds, [id('style.ts')]);
  const all = await executeQuery(new GraphQueryIndex(graph), request({ kind: 'impact', seeds: [id('asset.ts')], depth: 20, includeInferred: true, includeTypes: true }));
  assert(all.kind === 'impact'); assert.equal(all.directIds.length, 3);
});

test('directed path returns real import/reexport steps and cannot reverse a shared parent', async () => {
  const graph = fixture(['A.ts', 'B.ts', 'C.ts', 'D.ts'], [['A.ts', 'B.ts'], ['B.ts', 'C.ts', { kind: 'reexport' }], ['A.ts', 'D.ts']]);
  const index = new GraphQueryIndex(graph);
  const path = await executeQuery(index, request({ kind: 'path', fromId: id('A.ts'), toId: id('C.ts') }));
  assert.equal(path.outcome, 'found'); assert.deepEqual(path.nodeIds, [id('A.ts'), id('B.ts'), id('C.ts')]); assert.equal(path.relationIds.length, 2);
  const noPath = await executeQuery(index, request({ kind: 'path', fromId: id('B.ts'), toId: id('D.ts') }));
  assert.equal(noPath.outcome, 'notFoundWithinScope');
  const same = await executeQuery(index, request({ kind: 'path', fromId: id('A.ts'), toId: id('A.ts') }));
  assert.equal(same.outcome, 'found'); assert.deepEqual(same.nodeIds, [id('A.ts')]); assert.deepEqual(same.relationIds, []);
});

test('path excludes framework conventions and reports limits and unknown imports separately from no-path', async () => {
  const graph = fixture(['A.ts', 'B.ts', 'C.ts', 'D.ts'], [['A.ts', 'B.ts'], ['B.ts', 'C.ts'], ['C.ts', 'D.ts', { kind: 'framework' }]]);
  const index = new GraphQueryIndex(graph);
  assert.equal((await executeQuery(index, request({ kind: 'path', fromId: id('A.ts'), toId: id('D.ts') }))).outcome, 'notFoundWithinScope');
  const limited = await executeQuery(index, request({ kind: 'path', fromId: id('A.ts'), toId: id('C.ts') }, { maxNodes: 2 }));
  assert.equal(limited.outcome, 'notFoundWithinLimits'); assert.equal(limited.coverage, 'partial'); assert(limited.reasonCodes.includes('nodeLimit'));
  graph.unresolved.push({ sourceId: id('B.ts'), reason: 'computed', evidence: { rule: 'computed import' } });
  graph.coverage![1].unresolvedCount = 1; graph.coverage![1].reasonCodes.push('unresolvedReference');
  assert.equal((await executeQuery(new GraphQueryIndex(graph), request({ kind: 'path', fromId: id('A.ts'), toId: id('D.ts') }))).outcome, 'unknown');
  const impact = await executeQuery(new GraphQueryIndex(graph), request({ kind: 'impact', seeds: [id('D.ts')], depth: 20, includeInferred: false, includeTypes: true }));
  assert.equal(impact.coverage, 'partial'); assert(impact.reasonCodes.includes('unresolvedReference'));
});

test('neighbourhood expands one direction only and depth never crosses a common parent', async () => {
  const graph = fixture(['A.ts', 'B.ts', 'C.ts', 'D.ts'], [['A.ts', 'B.ts'], ['B.ts', 'C.ts'], ['A.ts', 'D.ts']]);
  const result = await executeQuery(new GraphQueryIndex(graph), request({ kind: 'neighbourhood', anchorId: id('B.ts'), direction: 'outgoing', depth: 1 }));
  assert.deepEqual(result.nodeIds, [id('B.ts'), id('C.ts')]);
  assert(!result.nodeIds.includes(id('D.ts')));
});

test('multi-root identity and multi-seed union count each consumer once', async () => {
  const graph = fixture(['App.ts', 'left.ts', 'right.ts'], [['App.ts', 'left.ts'], ['App.ts', 'right.ts']]);
  graph.nodes.push({ ...graph.nodes[0], id: id('App.ts', 'other'), file: { rootId: 'other', path: 'App.ts' } });
  const result = await executeQuery(new GraphQueryIndex(graph), request({ kind: 'impact', seeds: [id('left.ts'), id('right.ts')], depth: 20, includeInferred: false, includeTypes: true }));
  assert(result.kind === 'impact'); assert.deepEqual(result.directIds, [id('App.ts')]); assert(!result.nodeIds.includes(id('App.ts', 'other')));
});

test('cancellable traversal yields to the event loop without destroying the published query index', async () => {
  const names = Array.from({ length: 1500 }, (_, n) => `${n}.ts`);
  const graph = fixture(names, names.slice(1).map(name => [name, names[0]]));
  const index = new GraphQueryIndex(graph); let cancelled = false;
  setImmediate(() => setImmediate(() => { cancelled = true; }));
  const result = await executeQuery(index, request({ kind: 'impact', seeds: [id('0.ts')], depth: 20, includeInferred: false, includeTypes: true }), () => cancelled);
  assert.equal(result.operation, 'cancelled'); assert(result.reasonCodes.includes('cancelled'));
  assert(result.visitedNodes > 1); assert(result.visitedNodes < names.length);
  const again = await executeQuery(index, request({ kind: 'path', fromId: id('1.ts'), toId: id('0.ts') }));
  assert.equal(again.operation, 'success'); assert.equal(again.outcome, 'found');
});

test('generated directed graphs agree with independently computed transitive closure and shortest distances', async () => {
  let state = 7129;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let sample = 0; sample < 8; sample++) {
    const names = Array.from({ length: 18 }, (_, n) => `${n}.ts`);
    const edges: [string, string][] = [];
    const distances = names.map((_, from) => names.map((_, to) => from === to ? 0 : Infinity));
    for (let from = 0; from < names.length; from++) for (let to = 0; to < names.length; to++) if (from !== to && random() < 0.12) {
      edges.push([names[from], names[to]]); distances[from][to] = 1;
    }
    for (let via = 0; via < names.length; via++) for (let from = 0; from < names.length; from++) for (let to = 0; to < names.length; to++) distances[from][to] = Math.min(distances[from][to], distances[from][via] + distances[via][to]);
    const graph = fixture(names, edges), index = new GraphQueryIndex(graph);
    for (const seed of [0, 4, 11]) {
      const impact = await executeQuery(index, request({ kind: 'impact', seeds: [id(names[seed])], depth: 20, includeInferred: false, includeTypes: true }));
      assert(impact.kind === 'impact');
      assert.deepEqual(new Set([...impact.directIds, ...impact.indirectIds]), new Set(names.filter((_, from) => from !== seed && Number.isFinite(distances[from][seed])).map(name => id(name))));
      const target = (seed + 7) % names.length;
      const path = await executeQuery(index, request({ kind: 'path', fromId: id(names[seed]), toId: id(names[target]) }));
      assert.equal(path.outcome === 'found', Number.isFinite(distances[seed][target]));
      if (path.outcome === 'found') {
        assert.equal(path.relationIds.length, distances[seed][target]);
        for (let i = 0; i < path.relationIds.length; i++) {
          const edge: Relation = index.relations.get(path.relationIds[i])!;
          assert.equal(edge.sourceId, path.nodeIds[i]); assert.equal(edge.targetId, path.nodeIds[i + 1]);
        }
      }
    }
  }
});
