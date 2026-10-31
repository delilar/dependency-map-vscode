import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AnnotationStore, applyAnnotationMutation, createAnnotations, relationMarkKey, stableSerialize, validateAnnotations,
  type AnnotationsDocument, type RelationRef
} from '../../src/host/annotations';

const roots = [{ id: 'web', name: 'Web', path: 'C:/ignored/web' }, { id: 'child', name: 'Child', path: 'D:/ignored/child' }];
const file = { rootId: 'web', path: 'src/Profile.tsx' };
const target = { rootId: 'child', path: 'src/Profile.tsx' };
const relation: RelationRef = { source: file, target, kind: 'import', specifier: '@child/profile' };
function document(): AnnotationsDocument {
  return applyAnnotationMutation(createAnnotations(roots), { action: 'createGroup', groupId: 'task-auth', name: 'Auth', color: '#eab308' });
}

test('portable refs preserve multiple groups and notes without mutating input', () => {
  const original = document();
  let marked = applyAnnotationMutation(original, { action: 'mark', groupId: 'task-auth', files: [file, target], relations: [relation], note: 'Check API' });
  marked = applyAnnotationMutation(marked, { action: 'createGroup', groupId: 'other', name: 'Other', color: '#123456' });
  marked = applyAnnotationMutation(marked, { action: 'mark', groupId: 'other', files: [file] });
  marked = applyAnnotationMutation(marked, { action: 'note', groupId: 'task-auth', relations: [relation], note: 'Check contract' });
  assert.equal(original.groups[0].files.length, 0);
  assert.equal(marked.groups[0].files.length, 2);
  assert.equal(marked.groups[0].relations[0].note, 'Check contract');
  assert.equal(marked.groups[1].files.length, 1);
  const serialized = stableSerialize(marked);
  assert.ok(!serialized.includes('C:/ignored'));
  assert.ok(!serialized.includes('D:/ignored'));
  assert.deepEqual(validateAnnotations(JSON.parse(serialized)), JSON.parse(serialized));
});

test('logical relation marks aggregate duplicates and do not depend on source positions', () => {
  const marked = applyAnnotationMutation(document(), { action: 'mark', groupId: 'task-auth', relations: [relation, { ...relation }], files: [file, file] });
  assert.equal(marked.groups[0].relations.length, 1);
  assert.equal(marked.groups[0].files.length, 1);
  assert.equal(relationMarkKey(relation), relationMarkKey({ ...relation }));
  assert.ok(!stableSerialize(marked).includes('line'));
  const unmarked = applyAnnotationMutation(marked, { action: 'unmark', groupId: 'task-auth', relations: [relation] });
  assert.equal(unmarked.groups[0].relations.length, 0);
  assert.equal(unmarked.groups[0].files.length, 1);
});

test('createGroupAndMark creates a populated group in one JSONv1 mutation without altering existing groups', () => {
  const original = document();
  const next = applyAnnotationMutation(original, { action: 'createGroupAndMark', groupId: 'new-task', name: 'New task', color: '#123456', files: [file, file], relations: [relation], note: 'Created with selection' });
  assert.equal(next.version, 1);
  assert.equal(next.groups.length, 2);
  assert.deepEqual(next.groups[0], original.groups[0]);
  assert.equal(original.groups.length, 1);
  assert.equal(next.groups[1].files.length, 1);
  assert.equal(next.groups[1].relations[0].note, 'Created with selection');
  assert.equal(validateAnnotations(JSON.parse(stableSerialize(next))).groups.length, 2);
  assert.throws(() => applyAnnotationMutation(original, { action: 'createGroupAndMark', groupId: 'invalid', name: 'Invalid', color: '#123456', files: [{ rootId: 'missing', path: 'src/a.ts' }] }), /root/);
  assert.throws(() => applyAnnotationMutation(original, { action: 'createGroupAndMark', name: 'Empty', color: '#123456' }), /Select at least one/);
  assert.equal(original.groups.length, 1, 'invalid combined mutation cannot leave an empty group behind');
});

test('serialization is stable regardless of insertion order and handles missing files without filesystem lookup', () => {
  const first = applyAnnotationMutation(document(), { action: 'mark', groupId: 'task-auth', files: [file, target] });
  const second = applyAnnotationMutation(document(), { action: 'mark', groupId: 'task-auth', files: [target, file] });
  assert.equal(stableSerialize(first), stableSerialize(second));
  assert.equal(first.groups[0].files.length, 2);
});

test('validation rejects unknown versions, duplicate ids, unknown roots and unsafe paths', () => {
  assert.throws(() => validateAnnotations({ ...document(), version: 2 }), /version/);
  assert.throws(() => validateAnnotations({ ...document(), roots: [{ id: 'web', label: 'Web' }, { id: 'web', label: 'Duplicate' }] }), /duplicate/);
  const duplicate = document(); duplicate.groups.push({ ...duplicate.groups[0] });
  assert.throws(() => validateAnnotations(duplicate), /duplicate/);
  for (const unsafe of ['../secret', '/tmp/secret', 'C:/secret', 'a\\b', 'a//b', 'a/./b', 'a/../b']) {
    assert.throws(() => applyAnnotationMutation(document(), { action: 'mark', groupId: 'task-auth', files: [{ rootId: 'web', path: unsafe }] }), /path/);
  }
  assert.throws(() => applyAnnotationMutation(document(), { action: 'mark', groupId: 'task-auth', files: [{ rootId: 'unknown', path: 'src/a.ts' }] }), /root/);
  assert.throws(() => applyAnnotationMutation(document(), { action: 'updateGroup', groupId: 'task-auth', color: 'url(script)' }), /color/);
});

test('external endpoint retains application context and rejects extra untrusted fields', () => {
  const external: RelationRef = { source: file, target: { packageName: 'react', projectId: 'web-app' }, kind: 'import', specifier: 'react' };
  const marked = applyAnnotationMutation(document(), { action: 'mark', groupId: 'task-auth', relations: [external] });
  assert.match(stableSerialize(marked), /web-app/);
  const injected = structuredClone(marked) as unknown as { groups: { relations: object[] }[] };
  Object.assign(injected.groups[0].relations[0], { line: 10 });
  assert.throws(() => validateAnnotations(injected), /unsupported field/);
});

test('store creates only when saving, preserves formatting on semantic no-op, and reloads portable marks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-map-annotations-'));
  try {
    const filePath = path.join(directory, '.vscode', 'dependency-map.json');
    const store = new AnnotationStore(filePath);
    assert.equal(await store.load(), undefined);
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
    const marked = applyAnnotationMutation(document(), { action: 'mark', groupId: 'task-auth', files: [file], note: 'Missing in this branch' });
    await store.save(marked);
    const raw = JSON.stringify(marked);
    await fs.writeFile(filePath, raw);
    await store.load();
    const previous = (await fs.stat(filePath)).mtimeMs;
    await store.save(marked);
    assert.equal(await fs.readFile(filePath, 'utf8'), raw);
    assert.equal((await fs.stat(filePath)).mtimeMs, previous);
    assert.deepEqual(await new AnnotationStore(filePath).load(), marked);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('malformed and unknown-version documents are never overwritten', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-map-annotations-'));
  try {
    const filePath = path.join(directory, 'dependency-map.json');
    for (const content of ['{broken', JSON.stringify({ ...document(), version: 99 })]) {
      await fs.writeFile(filePath, content);
      const store = new AnnotationStore(filePath);
      await assert.rejects(store.load());
      await assert.rejects(store.save(document()));
      assert.equal(await fs.readFile(filePath, 'utf8'), content);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('stale saves fail after an external edit without touching the external document', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-map-annotations-'));
  try {
    const filePath = path.join(directory, 'dependency-map.json');
    const store = new AnnotationStore(filePath);
    await store.save(document());
    const external = applyAnnotationMutation(document(), { action: 'createGroup', groupId: 'external', name: 'External', color: '#123456' });
    const content = stableSerialize(external);
    await fs.writeFile(filePath, content);
    await assert.rejects(store.save(document()), /changed externally/);
    assert.equal(await fs.readFile(filePath, 'utf8'), content);
    assert.deepEqual((await fs.readdir(directory)), ['dependency-map.json']);
    const reloaded = await store.load();
    const updated = applyAnnotationMutation(reloaded!, { action: 'updateGroup', groupId: 'task-auth', name: 'Updated' });
    await store.save(updated);
    assert.equal((await store.load())!.groups.length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a newly created external file conflicts with a previously missing file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-map-annotations-'));
  try {
    const filePath = path.join(directory, 'dependency-map.json');
    const store = new AnnotationStore(filePath);
    await store.load();
    await fs.writeFile(filePath, '{}');
    await assert.rejects(store.save(document()), /changed externally/);
    assert.equal(await fs.readFile(filePath, 'utf8'), '{}');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('rename failure preserves the original document and cleans temporary files', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-map-annotations-'));
  try {
    const filePath = path.join(directory, 'dependency-map.json');
    const store = new AnnotationStore(filePath);
    await store.save(document());
    const original = await fs.readFile(filePath, 'utf8');
    const nativeFs = require('node:fs/promises') as typeof fs;
    context.mock.method(nativeFs, 'rename', async () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); });
    const updated = applyAnnotationMutation(document(), { action: 'updateGroup', groupId: 'task-auth', name: 'Updated' });
    await assert.rejects(store.save(updated), { code: 'EACCES' });
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    assert.deepEqual(await fs.readdir(directory), ['dependency-map.json']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
