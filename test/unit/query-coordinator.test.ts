import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryCoordinator } from '../../src/host/query-coordinator';
import { emptyGraph } from '../../src/shared/model';
import { queryLimits, type IndexState, type QueryResult } from '../../src/shared/query-model';
const index: IndexState = { version: { epoch: 'a', revision: 2, scopeRevision: 1 }, state: 'ready', reasonCodes: [] };
const graph = { ...emptyGraph(), nodes: [{ id: 'a', label: 'a', kind: 'file' as const, format: '.ts', projectId: 'p', file: { rootId: 'r', path: 'a.ts' } }] };
const reply = (requestId: string): QueryResult => ({ type: 'queryResult', requestId, graph: index.version, kind: 'path', operation: 'success', coverage: 'complete', freshness: 'current', reasonCodes: [], limits: queryLimits, visitedNodes: 1, examinedRelations: 0, nodeIds: ['a'], relationIds: [], witnesses: [], outcome: 'found' });
test('new intent, stale state, epochs and Git revision fence late query replies', () => {
  const c = new QueryCoordinator(), query = { kind: 'path' as const, fromId: 'a', toId: 'a' };
  const a = c.start(query, index, graph)!;
  const b = c.start(query, index, graph)!;
  assert(!c.accept(reply(a.requestId), index));
  assert(!c.accept(reply(b.requestId), { ...index, state: 'stale' }));
  assert(!c.accept({ ...reply(b.requestId), graph: { ...index.version, epoch: 'old' } }, index));
  assert(c.accept(reply(b.requestId), index));
  c.invalidate(); assert.equal(c.active?.state, 'stale');
  const git = c.start(query, index, graph, 7)!;
  assert(!c.accept({ ...reply(git.requestId), gitRevision: 7 }, index, 8));
  assert(c.accept({ ...reply(git.requestId), gitRevision: 7 }, index, 7));
  c.cancel(); assert.equal(c.active?.state, 'cancelled');
  assert(!c.start(query, { ...index, state: 'building' }, graph));
});

test('repeated failed attempts preserve the last successfully completed answer', () => {
  const c = new QueryCoordinator(), query = { kind: 'path' as const, fromId: 'a', toId: 'a' };
  const first = c.start(query, index, graph)!;
  assert(c.accept(reply(first.requestId), index));
  const second = c.start(query, index, graph)!;
  assert(c.accept({ ...reply(second.requestId), operation: 'failed', nodeIds: [] }, index));
  const third = c.start(query, index, graph)!;
  assert.equal(c.active?.previousResult?.requestId, first.requestId);
  assert.notEqual(c.active?.previousResult?.requestId, third.requestId);
});
