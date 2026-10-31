import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractEnvironmentKeys, isEnvironmentFile } from '../../src/host/environment';
import { resolveAllowedFile, sameFilePath } from '../../src/host/navigation';
import { isUiMessage, isSavedUiState } from '../../src/shared/protocol';
import { initialView } from '../../src/shared/model';

test('environment boundary only returns names and skips multiline secret contents', () => {
  assert.equal(isEnvironmentFile('C:\\app\\.ENV.LOCAL'), true);
  const keys = extractEnvironmentKeys('export API_KEY="sentinel\nFAKE=value\nend"\nPUBLIC_NAME=ok\n#IGNORED=x');
  assert.deepEqual(keys.map(item => item.name), ['API_KEY', 'PUBLIC_NAME']);
  assert.ok(!JSON.stringify(keys).includes('sentinel'));
});

test('UI guard rejects arbitrary URI commands and malformed annotation payload', () => {
  assert.equal(isUiMessage({ type: 'execute', uri: 'file:///secret' }), false);
  assert.equal(isUiMessage({ type: 'annotation', action: 'mark', nodeIds: [7] }), false);
  assert.equal(isUiMessage({ type: 'openFile', nodeId: 'known-id' }), true);
  assert.equal(isUiMessage({ type: 'setView', view: { ...initialView(), arbitrary: 'unexpected content' } }), false);
});

test('annotation path comparison respects platform casing and normalizes parent segments', () => {
  const file = path.join(os.tmpdir(), 'DependencyMap', 'groups.json');
  assert.ok(sameFilePath(file, path.join(path.dirname(file), 'unused', '..', 'groups.json')));
  assert.equal(sameFilePath(file, file.toUpperCase()), process.platform === 'win32');
  assert.equal(sameFilePath(file, `${file}.bak`), false);
});

test('local canvas state guard permits coordinates but rejects unbounded or arbitrary payload', () => {
  assert.ok(isSavedUiState({ canvas: { zoom: 1.2, pan: { x: 12, y: -4 }, positions: { file: { x: 1, y: 2 } } }, query: 'index.tsx', collapsedGroupIds: ['group:app'] }));
  assert.equal(isSavedUiState({ canvas: { zoom: Infinity } }), false);
  assert.equal(isSavedUiState({ canvas: { positions: { file: { x: NaN, y: 1 } } } }), false);
  assert.equal(isSavedUiState({ sourceText: 'unexpected file contents' }), false);
});

test('local panel sizes and node depths accept legacy state and reject malformed settings', () => {
  assert.ok(isUiMessage({ type: 'setView', view: initialView() }));
  assert.ok(isUiMessage({ type: 'setView', view: { ...initialView(), nodeDepths: { 'file:app:src/main.ts': 2 } } }));
  for (const depth of [0, -1, 1.5, 21, Infinity, '2']) {
    assert.equal(isUiMessage({ type: 'setNodeDepth', nodeId: 'file:app:src/main.ts', depth }), false);
    assert.equal(isUiMessage({ type: 'setView', view: { ...initialView(), nodeDepths: { 'file:app:src/main.ts': depth } } }), false);
  }
  assert.ok(isUiMessage({ type: 'setNodeDepth', nodeId: 'file:app:src/main.ts', depth: null }));
  assert.ok(isUiMessage({ type: 'resetNodeDepths' }));
  assert.equal(isUiMessage({ type: 'setNodeDepth', nodeId: 'group:app', depth: 2 }), false);
  const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`file:app:${index}.ts`, 2]));
  assert.equal(isUiMessage({ type: 'setView', view: { ...initialView(), nodeDepths: tooMany } }), false);
  assert.ok(isSavedUiState({ panelSizes: { leftWidth: 250, rightWidth: 280, toolbarHeight: 80 }, showGroupColors: false }));
  for (const panelSizes of [{ leftWidth: NaN }, { rightWidth: -1 }, { toolbarHeight: 10001 }, { unknown: 2 }]) assert.equal(isSavedUiState({ panelSizes }), false);
  assert.equal(isSavedUiState({ showGroupColors: 'yes' }), false);
  assert.ok(isUiMessage({ type: 'annotation', action: 'createGroupAndMark', requestId: 'one', name: 'Task', color: '#123456', relationIds: ['edge'] }));
  assert.equal(isUiMessage({ type: 'annotation', action: 'createGroupAndMark', requestId: 5 }), false);
});

test('navigation denies traversal, node_modules and escaped symlink', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dependency-map-nav-'));
  try {
    const root = path.join(directory, 'app');
    await mkdir(root);
    await writeFile(path.join(root, 'file.ts'), '');
    await writeFile(path.join(directory, 'outside.ts'), '');
    const roots = [{ id: 'app', name: 'app', path: root }];
    assert.equal(await resolveAllowedFile({ rootId: 'app', path: 'file.ts' }, roots), path.join(root, 'file.ts'));
    await assert.rejects(resolveAllowedFile({ rootId: 'app', path: '../outside.ts' }, roots));
    await assert.rejects(resolveAllowedFile({ rootId: 'app', path: 'node_modules/x.js' }, roots));
    await assert.rejects(resolveAllowedFile({ rootId: 'app', path: '.git/config' }, roots));
    await assert.rejects(resolveAllowedFile({ rootId: 'app', path: '.GIT/config' }, roots));
    await assert.rejects(resolveAllowedFile({ rootId: 'hidden', path: 'config' }, [{ id: 'hidden', name: 'hidden', path: path.join(directory, '.git') }]));
    await assert.rejects(resolveAllowedFile({ rootId: 'hidden', path: 'index.js' }, [{ id: 'hidden', name: 'hidden', path: path.join(directory, 'node_modules') }]));
    try { await symlink(directory, path.join(root, 'escape'), 'junction'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    await assert.rejects(resolveAllowedFile({ rootId: 'app', path: 'escape/outside.ts' }, roots));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
