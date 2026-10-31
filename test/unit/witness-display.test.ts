import assert from 'node:assert/strict';
import test from 'node:test';
import { witnessSteps } from '../../src/webview/analysis-workbench';
import type { GraphNode, Relation } from '../../src/shared/model';

test('symbol provenance and consumers display actual edge directions even when traversal reverses', () => {
  const nodes = new Map(['barrel', 'origin', 'consumer'].map(id => [id, { id, label: id, kind: 'file', projectId: 'p', format: '.ts', file: { rootId: 'r', path: `${id}.ts` } } as GraphNode]));
  const relations = new Map([
    ['forward', { id: 'forward', sourceId: 'barrel', targetId: 'origin', kind: 'reexport', certainty: 'confirmed', bindings: [], evidence: [] } as Relation],
    ['consume', { id: 'consume', sourceId: 'consumer', targetId: 'barrel', kind: 'import', certainty: 'confirmed', bindings: [], evidence: [] } as Relation],
  ]);
  assert.equal(witnessSteps({ nodeId: 'consumer', nodeIds: ['origin', 'barrel', 'consumer'], relationIds: ['forward', 'consume'], depth: 2 }, nodes, relations), 'r/barrel.ts → r/origin.ts · r/consumer.ts → r/barrel.ts');
});
