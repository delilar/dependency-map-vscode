import assert from 'node:assert/strict';
import test from 'node:test';
import { isQuerySpec, isQueryRequest, queryLimits } from '../../src/shared/query-model';
import { isUiMessage } from '../../src/shared/protocol';

test('query boundary rejects mixed kinds, huge limits, extras and malformed numbers', () => {
  const query = { kind: 'path', fromId: 'file:root:a.ts', toId: 'file:root:b.ts' };
  const request = { type: 'query', apiVersion: 1, requestId: 'q1', graph: { epoch: 'one', revision: 3, scopeRevision: 1 }, query, limits: queryLimits };
  assert(isQueryRequest(request));
  assert(!isQuerySpec({ ...query, seeds: ['file:root:a.ts'] }));
  assert(!isQueryRequest({ ...request, limits: { ...queryLimits, maxNodes: Infinity } }));
  assert(!isQueryRequest({ ...request, graph: { ...request.graph, revision: -1 } }));
  assert(!isQueryRequest({ ...request, source: 'must not be accepted' }));
  assert(!isQuerySpec({ kind: 'impact', seeds: [], depth: 1, includeTypes: true, includeInferred: false }));
});

test('UI analytical actions are targeted and validated independently from legacy view', () => {
  assert(isUiMessage({ type: 'startQuery', query: { kind: 'path', fromId: 'a', toId: 'b' } }));
  assert(!isUiMessage({ type: 'startQuery', query: { kind: 'path', fromId: 'a', toId: 'b', command: 'unsafe' } }));
  assert(isUiMessage({ type: 'branch', nodeId: 'file:root:a', direction: 'incoming', action: 'expand' }));
  assert(!isUiMessage({ type: 'branch', nodeId: 'file:root:a', direction: 'both', action: 'expand' }));
  assert(!isUiMessage({ type: 'taskContext', groupId: 'group', action: 'restore', source: 'unsafe' }));
});
