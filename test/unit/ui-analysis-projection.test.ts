import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyGraph, initialView, type GraphNode, type Relation } from '../../src/shared/model';
import { projectGraph, activeBranchContributions } from '../../src/webview/graph';

const nodes = ['A', 'B', 'C', 'D'].map((label): GraphNode => ({ id: label, label, kind: 'file', projectId: 'root', format: label === 'B' ? '.json' : '.ts', file: { rootId: 'root', path: label } }));
const relations = [['A', 'B'], ['B', 'C'], ['A', 'D']].map(([sourceId, targetId], i): Relation => ({ id: `e${i}`, sourceId, targetId, kind: 'import', certainty: 'confirmed', bindings: [], evidence: [] }));
const graph = { ...emptyGraph(), nodes, relations };
const view = { ...initialView(), focusId: 'A', depth: 1 };
test('analytical projection filters presentation after full-index result without reseeding', () => {
  const result = new Set(['A', 'B', 'C']);
  const hidden = projectGraph(graph, view, { queryNodeIds: result, queryRelationIds: new Set(['e0', 'e1']), format: '.ts' });
  assert.deepEqual(hidden.nodes.map(n => n.id), ['A', 'C']);
  assert.deepEqual(hidden.edges, []);
  const shown = projectGraph(graph, view, { queryNodeIds: result, queryRelationIds: new Set(['e0', 'e1']), format: '.ts', forcedIds: new Set(['B']) });
  assert.deepEqual(shown.nodes.map(n => n.id), ['A', 'B', 'C']);
  assert.deepEqual(shown.edges.map(e => e.id), ['e0', 'e1']);
  assert.equal(view.focusId, 'A');
});
test('branch contributions add only their computed members and collapse preserves the base radius', () => {
  assert.deepEqual(projectGraph(graph, view, { direction: 'outgoing' }).nodes.map(n => n.id), ['A', 'B', 'D']);
  assert.deepEqual(projectGraph(graph, view, { direction: 'outgoing', branchNodeIds: new Set(['B', 'C']) }).nodes.map(n => n.id), ['A', 'B', 'C', 'D']);
  assert.deepEqual(projectGraph(graph, view, { direction: 'outgoing', branchNodeIds: new Set(['B']) }).nodes.map(n => n.id), ['A', 'B', 'D']);
});
test('saved branch anchors outside the reached area remain dormant, nested and shared branches survive only valid contributions', () => {
  const result = activeBranchContributions(new Set(['A']), [
    { anchorId: 'C', result: { nodeIds: ['C', 'D'], relationIds: ['cd'] } },
    { anchorId: 'B', result: { nodeIds: ['B', 'C'], relationIds: ['bc'] } },
    { anchorId: 'X', result: { nodeIds: ['X', 'Y'], relationIds: ['xy'] } },
    { anchorId: 'A', result: { nodeIds: ['A', 'B'], relationIds: ['ab'] } }
  ]);
  assert.deepEqual([...result.nodeIds].sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual([...result.relationIds].sort(), ['ab', 'bc', 'cd']);
  assert.equal(activeBranchContributions(new Set(['Z']), [{ anchorId: 'A', result: { nodeIds: ['A', 'B'], relationIds: ['ab'] } }]).nodeIds.size, 0);
});
