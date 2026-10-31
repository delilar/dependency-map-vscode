import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalTaskContextStore, taskContextStoreKey, isTaskContextData, previewTaskContext, fingerprintGroup } from '../../src/host/task-contexts';
import { emptyGraph, initialView } from '../../src/shared/model';
import type { TaskContextData } from '../../src/shared/query-model';

function memory() {
  const values = new Map<string, unknown>();
  let writes = 0;
  return { values, writes: () => writes, memento: { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { writes++; values.set(key, structuredClone(value)); } } };
}
const data = (): TaskContextData => ({ view: { ...initialView(), focusId: 'file:root:src/App.tsx', follow: true }, ui: { format: '.tsx', canvas: { zoom: 1.2, pan: { x: 3, y: 4 }, positions: { 'file:root:src/App.tsx': { x: 1, y: 2 } } } }, query: { kind: 'impact', seeds: ['file:root:src/App.tsx'], depth: 2, includeInferred: false, includeTypes: true }, branches: [{ id: 'branch', anchorId: 'file:root:src/App.tsx', depth: 1, direction: 'outgoing' }], selection: { nodeIds: ['file:root:src/App.tsx'], relationIds: [] } });

test('task context is one manual local record per store/group, isolated from shared JSON and global UI state', async () => {
  const f = memory(), store = new LocalTaskContextStore(f.memento, () => 100);
  const shared = '{"version":1,"groups":[]}';
  f.values.set('dependencyMap.uiState', { query: 'global' });
  await store.save('root:.vscode/dependency-map.json', 'same-group', data(), fingerprintGroup({ name: 'Task' }));
  await store.save('other:.vscode/dependency-map.json', 'same-group', data(), 'other');
  const replacement = data(); replacement.ui.query = 'updated';
  await store.save('root:.vscode/dependency-map.json', 'same-group', replacement, 'new');
  assert.equal(store.list('root:.vscode/dependency-map.json').length, 1);
  assert.equal(store.load('root:.vscode/dependency-map.json', 'same-group')?.data.ui.query, 'updated');
  assert.equal(store.load('other:.vscode/dependency-map.json', 'same-group')?.groupFingerprint, 'other');
  assert.deepEqual(f.values.get('dependencyMap.uiState'), { query: 'global' });
  assert.equal(shared, '{"version":1,"groups":[]}');
  assert.equal(f.writes(), 3);
  const restarted = new LocalTaskContextStore(f.memento);
  const loaded = restarted.load('root:.vscode/dependency-map.json', 'same-group')!;
  loaded.data.ui.query = 'mutated-copy';
  assert.equal(restarted.load('root:.vscode/dependency-map.json', 'same-group')?.data.ui.query, 'updated');
});

test('restore preview pins saved focus, keeps missing references dormant, and reports group drift without writing', async () => {
  const f = memory(), store = new LocalTaskContextStore(f.memento, () => 200);
  const saved = await store.save('root:.vscode/dependency-map.json', 'task', data(), 'old');
  const before = f.writes();
  const preview = previewTaskContext(saved, emptyGraph(), 'new', false);
  assert.deepEqual(preview.missingNodeIds, ['file:root:src/App.tsx']);
  assert.equal(preview.data.view.follow, false); assert.equal(preview.data.view.focusId, 'file:root:src/App.tsx');
  assert.equal(preview.groupChanged, true); assert.equal(preview.groupMissing, false);
  assert(preview.reasonCodes.includes('followPaused'));
  assert.equal(f.writes(), before);
  assert.equal(previewTaskContext(saved, emptyGraph(), undefined, true).groupMissing, true);
});

test('unknown local versions and damaged records are preserved, never silently replaced', async () => {
  const f = memory();
  const raw = { version: 99, contexts: [{ privateFutureField: 'preserve' }] };
  f.values.set(taskContextStoreKey, raw);
  const store = new LocalTaskContextStore(f.memento);
  assert.throws(() => store.list('root'), /version/i);
  await assert.rejects(store.save('root', 'group', data(), 'hash'), /version/i);
  assert.deepEqual(f.values.get(taskContextStoreKey), raw); assert.equal(f.writes(), 0);
  f.values.set(taskContextStoreKey, { version: 1, contexts: [{ version: 1 }] });
  await assert.rejects(store.remove('root', 'group'), /invalid/i);
  assert.equal(f.writes(), 0);
});

test('task contexts reject sources/results/unsafe refs, retain capacity without eviction and serialize concurrent saves', async () => {
  assert.equal(isTaskContextData({ ...data(), source: 'SECRET' }), false);
  assert.equal(isTaskContextData({ ...data(), queryResult: { nodeIds: [] } }), false);
  const bad = data(); bad.branches[0].anchorId = 'file:root:../outside.ts'; assert.equal(isTaskContextData(bad), false);
  const absolute = data(); absolute.view.focusId = 'file:root:C:/private.ts'; assert.equal(isTaskContextData(absolute), false);
  const f = memory(), store = new LocalTaskContextStore(f.memento);
  await Promise.all(Array.from({ length: 100 }, (_, i) => store.save('root', `task-${i}`, data(), 'hash')));
  assert.equal(store.list('root').length, 100);
  await assert.rejects(store.save('root', 'task-over-cap', data(), 'hash'), /limit/i);
  assert.equal(store.list('root').length, 100);
  await store.save('root', 'task-0', data(), 'replaced');
  assert.equal(store.list('root').length, 100);
  await store.remove('root', 'task-0'); assert.equal(store.list('root').length, 99);
});
