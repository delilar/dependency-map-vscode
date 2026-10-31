import assert from 'node:assert/strict';
import test from 'node:test';
import { collectNeighbourhood, type NeighbourhoodOptions } from '../../src/webview/depth';

const relations = (...pairs: [string, string][]) => pairs.map(([sourceId, targetId]) => ({ sourceId, targetId }));
const ids = (values: Iterable<string>) => [...values].sort();
function options(edges = relations(['A', 'B'], ['B', 'C'], ['A', 'D'], ['D', 'E'])): NeighbourhoodOptions {
  return { nodeIds: ['A', 'B', 'C', 'D', 'E', 'F'], relations: edges, eligibleIds: new Set(['A', 'B', 'C', 'D', 'E', 'F']), focusId: 'A', depth: 1, direction: 'both' };
}

test('local radius extends its reachable branch alongside the unchanged global radius', () => {
  assert.deepEqual(ids(collectNeighbourhood(options())), ['A', 'B', 'D']);
  assert.deepEqual(ids(collectNeighbourhood({ ...options(), nodeDepths: { B: 2 } })), ['A', 'B', 'C', 'D']);
  const graph = options(relations(['A', 'B'], ['B', 'C'], ['C', 'F'], ['A', 'D'], ['D', 'E']));
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, nodeDepths: { B: 2 } })), ['A', 'B', 'C', 'D', 'F']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, nodeDepths: { B: 2, D: 1 } })), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, depth: 3, nodeDepths: { B: 1 } })), ['A', 'B', 'C', 'D', 'E', 'F']);
});

test('incoming/outgoing traversal and cycles preserve bounded graph-neighbourhood meaning', () => {
  const graph = options(relations(['A', 'B'], ['B', 'C'], ['C', 'B'], ['D', 'A'], ['E', 'D']));
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, direction: 'outgoing', nodeDepths: { B: 2 } })), ['A', 'B', 'C']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, direction: 'incoming', nodeDepths: { D: 1 } })), ['A', 'D', 'E']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, depth: 20, nodeDepths: { B: 20, C: 20 } })), ['A', 'B', 'C', 'D', 'E']);
});

test('unreachable anchors are dormant and filtered intermediates stop expansion', () => {
  const graph = options(relations(['A', 'B'], ['B', 'C'], ['C', 'F'], ['D', 'E']));
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, nodeDepths: { D: 20 } })), ['A', 'B']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, eligibleIds: new Set(['A', 'C', 'F']), nodeDepths: { B: 2 } })), ['A']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, eligibleIds: new Set(['A', 'B', 'F']), nodeDepths: { B: 2 } })), ['A', 'B']);
});

test('search reveal is a zero-budget seed unless a local radius is configured', () => {
  const graph = options(relations(['A', 'B'], ['D', 'E']));
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, forcedIds: new Set(['D']) })), ['A', 'B', 'D']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, forcedIds: new Set(['D']), nodeDepths: { D: 1 } })), ['A', 'B', 'D', 'E']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, eligibleIds: new Set(['A', 'B', 'E']), forcedIds: new Set(['D']), nodeDepths: { D: 1 } })), ['A', 'B', 'D', 'E']);
});

test('depth counts real import and reexport hops; hidden focus remains only a traversal origin', () => {
  const graph: NeighbourhoodOptions = { nodeIds: ['A', 'barrel', 'Button'], relations: relations(['A', 'barrel'], ['barrel', 'Button']), eligibleIds: new Set(['A', 'barrel', 'Button']), focusId: 'A', depth: 1 };
  assert.deepEqual(ids(collectNeighbourhood(graph)), ['A', 'barrel']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, depth: 2 })), ['A', 'Button', 'barrel']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, eligibleIds: new Set(['barrel', 'Button']) })), ['barrel']);
  assert.deepEqual(ids(collectNeighbourhood({ ...graph, depth: 20, eligibleIds: new Set(['A', 'Button']) })), ['A']);
});

function independentlyExpanded(options: NeighbourhoodOptions): Set<string> {
  const known = new Set(options.nodeIds);
  const allowed = new Set(options.eligibleIds);
  const result = new Set<string>();
  for (const forced of options.forcedIds ?? []) if (known.has(forced)) { allowed.add(forced); result.add(forced); }
  const breadthFirst = (seed: string, radius: number) => {
    let layer = new Set([seed]); const visited = new Set([seed]);
    for (let distance = 0; distance <= radius; distance++) {
      for (const id of layer) if (allowed.has(id)) result.add(id);
      const next = new Set<string>();
      for (const id of layer) for (const edge of options.relations) {
        const neighbours: string[] = [];
        if (options.direction !== 'incoming' && edge.sourceId === id) neighbours.push(edge.targetId);
        if (options.direction !== 'outgoing' && edge.targetId === id) neighbours.push(edge.sourceId);
        for (const neighbour of neighbours) if (known.has(neighbour) && allowed.has(neighbour) && !visited.has(neighbour)) { visited.add(neighbour); next.add(neighbour); }
      }
      layer = next;
    }
  };
  if (options.focusId && known.has(options.focusId)) breadthFirst(options.focusId, options.depth);
  const expanded = new Set<string>();
  while (true) {
    const active = Object.entries(options.nodeDepths ?? {}).filter(([id]) => result.has(id) && !expanded.has(id));
    if (!active.length) break;
    for (const [id, depth] of active) { expanded.add(id); breadthFirst(id, depth); }
  }
  return result;
}

test('budget traversal equals independent union-of-BFS on every three-node directed graph', () => {
  const possible: [string, string][] = [['A', 'B'], ['A', 'C'], ['B', 'A'], ['B', 'C'], ['C', 'A'], ['C', 'B']];
  for (let mask = 0; mask < 64; mask++) for (const direction of ['both', 'incoming', 'outgoing'] as const) for (const depth of [0, 1, 2]) {
    for (const eligibleIds of [new Set(['A', 'B', 'C']), new Set(['A', 'C'])]) {
      const input: NeighbourhoodOptions = {
        nodeIds: ['A', 'B', 'C'], relations: relations(...possible.filter((_, index) => mask & (1 << index))),
        eligibleIds, focusId: 'A', depth, direction, nodeDepths: { B: 2, C: 1 }, forcedIds: mask % 3 === 0 ? new Set(['C']) : undefined
      };
      assert.deepEqual(ids(collectNeighbourhood(input)), ids(independentlyExpanded(input)), `mask=${mask} direction=${direction} depth=${depth}`);
    }
  }
});
