import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { PassiveGitState, type CachedGitExtension, type CachedGitRepository } from '../../src/host/git-state';
import { emptyGraph, fileId } from '../../src/shared/model';

function event() {
  const listeners = new Set<() => void>();
  return { listen: (fn: () => void) => { listeners.add(fn); return { dispose: () => { listeners.delete(fn); } }; }, fire: () => { for (const fn of [...listeners]) fn(); }, count: () => listeners.size };
}
const base = path.resolve('fixture-git-workspaces');
const roots = [{ id: 'left', name: 'left', path: path.join(base, 'left') }, { id: 'right', name: 'right', path: path.join(base, 'right') }];
const uri = (file: string) => ({ scheme: 'file', fsPath: file });
const ref = (rootId: string, name: string) => ({ rootId, path: name });
function fixture() {
  const repoEvent = event(), openEvent = event(), enableEvent = event();
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('must never execute'); };
  const repository: CachedGitRepository = {
    rootUri: uri(roots[0].path),
    state: { indexChanges: [], workingTreeChanges: [], mergeChanges: [], onDidChange: repoEvent.listen },
  };
  Object.assign(repository, { status: forbidden, show: forbidden, diff: forbidden });
  const api = { repositories: [repository], onDidOpenRepository: openEvent.listen, onDidCloseRepository: openEvent.listen, openRepository: forbidden };
  const extension: CachedGitExtension = { isActive: true, exports: { enabled: true, getAPI: () => api, onDidChangeEnablement: enableEvent.listen } };
  Object.assign(extension, { activate: forbidden });
  return { repository, extension, api, repoEvent, openEvent, enableEvent, forbiddenCalls: () => forbiddenCalls };
}

test('passive Git preserves staged/working-tree/rename/conflict and keeps paths root-relative', () => {
  const f = fixture();
  const current = path.join(roots[0].path, 'src/current.ts');
  f.repository.state.indexChanges.push({ uri: uri(current), originalUri: uri(path.join(roots[0].path, 'src/old.ts')), status: 3 });
  f.repository.state.workingTreeChanges.push({ uri: uri(current), originalUri: uri(current), status: 5 });
  f.repository.state.mergeChanges.push({ uri: uri(path.join(roots[0].path, '.env.local')), status: 18 });
  f.repository.state.workingTreeChanges.push({ uri: uri(path.join(base, 'PRIVATE_OUTSIDE.ts')), status: 5 });
  const graph = emptyGraph();
  graph.nodes = [{ id: fileId(ref('left', 'src/current.ts')), file: ref('left', 'src/current.ts'), kind: 'file', label: 'current.ts', projectId: 'left', format: '.ts' }];
  const adapter = new PassiveGitState(() => f.extension);
  const result = adapter.observe(roots, graph, [current]);
  assert.equal(result.providerState, 'available');
  const row = result.rows.find(row => row.relativePath === 'src/current.ts')!;
  assert.equal(row.staged, true); assert.equal(row.unstaged, true); assert.equal(row.dirty, true);
  assert.equal(row.originalRelativePath, 'src/old.ts'); assert.equal(row.indexedNodeId, graph.nodes[0].id);
  assert.equal(result.rows.find(row => row.relativePath === '.env.local')?.conflict, true);
  assert(result.omissions > 0);
  const serialized = JSON.stringify(result);
  assert(!serialized.includes(base)); assert(!serialized.includes('PRIVATE_OUTSIDE')); assert(!serialized.includes('API_KEY_VALUE'));
  assert.equal(f.forbiddenCalls(), 0);
});

test('inactive/disabled Git does not activate or even obtain its API', () => {
  let calls = 0;
  const extension = { isActive: false, get exports() { calls++; throw new Error('not active'); } };
  assert.equal(new PassiveGitState(() => extension as unknown as CachedGitExtension).observe(roots, emptyGraph()).providerState, 'inactive');
  assert.equal(calls, 0);
  assert.equal(new PassiveGitState(() => ({ isActive: true, exports: { enabled: false, getAPI() { calls++; throw new Error('disabled'); } } })).observe(roots, emptyGraph()).providerState, 'disabled');
  assert.equal(calls, 0);
});

test('minimum and current Git APIs show only physical allowed untracked inventory, and buffer-only separately', () => {
  const f = fixture();
  const physical = ref('left', 'new.ts'), buffer = ref('left', 'buffer.ts');
  const graph = emptyGraph();
  graph.nodes = [physical, buffer].map(file => ({ id: fileId(file), file, kind: 'file' as const, label: file.path, projectId: 'left', format: '.ts' }));
  f.repository.state.workingTreeChanges.push({ uri: uri(path.join(roots[0].path, 'new.ts')), status: 7 });
  f.repository.state.untrackedChanges = [{ uri: uri(path.join(roots[0].path, 'buffer.ts')), status: 7 }];
  f.repository.state.workingTreeChanges.push({ uri: uri(path.join(roots[0].path, '.git/config')), status: 5 });
  const result = new PassiveGitState(() => f.extension).observe(roots, graph, [path.join(roots[0].path, 'buffer.ts')], { physicalNodeIds: new Set([fileId(physical)]) });
  assert.equal(result.rows.find(row => row.relativePath === 'new.ts')?.untracked, true);
  const dirty = result.rows.find(row => row.relativePath === 'buffer.ts')!;
  assert.equal(dirty.untracked, false); assert.equal(dirty.scopeStatus, 'bufferOnly');
  assert(!result.rows.some(row => row.relativePath.includes('.git')));
});

test('passive Git separates repositories, reports per-repository failures, bounds rows and disposes subscriptions', () => {
  const f = fixture(), changed: string[] = [];
  f.api.repositories.push({ rootUri: uri(roots[1].path), get state() { throw new Error('C:/private/API_KEY_VALUE'); } } as unknown as CachedGitRepository);
  const adapter = new PassiveGitState(() => f.extension, () => changed.push('changed'));
  adapter.watch();
  assert.equal(f.repoEvent.count(), 1);
  f.repoEvent.fire(); assert.equal(changed.length, 1);
  const result = adapter.observe(roots, emptyGraph());
  assert.equal(result.repositories.length, 2); assert.equal(result.repositories.filter(repo => repo.state === 'failed').length, 1);
  assert(result.reasonCodes.includes('repositoryReadFailed'));
  assert(!JSON.stringify(result).includes('API_KEY_VALUE'));
  const revision = result.gitRevision;
  assert.equal(adapter.observe(roots, emptyGraph()).gitRevision, revision);
  adapter.dispose(); assert.equal(f.repoEvent.count(), 0); assert.equal(f.openEvent.count(), 0);
  assert.equal(f.forbiddenCalls(), 0);
});

test('uninitialized provider and bounded metadata remain explicitly incomplete', () => {
  const f = fixture();
  const adapter = new PassiveGitState(() => f.extension);
  Object.assign(f.api, { state: 'uninitialized' });
  assert.equal(adapter.observe(roots, emptyGraph()).providerState, 'unavailable');
  Object.assign(f.api, { state: 'initialized' });
  for (let i = 0; i < 4; i++) f.repository.state.indexChanges.push({ uri: uri(path.join(roots[0].path, `${i}.ts`)), status: 0 });
  const limited = adapter.observe(roots, emptyGraph(), [], { maxRows: 2 });
  assert.equal(limited.rows.length, 2); assert.equal(limited.omissions, 2);
  assert(limited.reasonCodes.includes('rowLimit'));
  f.repository.state.indexChanges = [{ uri: uri(path.join(roots[0].path, 'dist/bundle.js')), status: 0 }];
  assert.equal(adapter.observe(roots, emptyGraph(), [], { exclude: ['dist'] }).rows.length, 0);
});

test('rename between opened roots keeps both portable identities and two repositories do not merge same paths', () => {
  const f = fixture();
  f.repository.rootUri = uri(base);
  f.repository.state.indexChanges.push({ uri: uri(path.join(roots[1].path, 'src/current.ts')), originalUri: uri(path.join(roots[0].path, 'src/old.ts')), status: 3 });
  const graph = emptyGraph();
  const adapter = new PassiveGitState(() => f.extension);
  const renamed = adapter.observe(roots, graph).rows[0];
  assert.deepEqual(renamed.file, ref('right', 'src/current.ts')); assert.deepEqual(renamed.originalFile, ref('left', 'src/old.ts'));
  assert.equal(renamed.originalRelativePath, 'src/old.ts');
  f.repository.rootUri = uri(roots[0].path);
  f.repository.state.indexChanges = [{ uri: uri(path.join(roots[0].path, 'same.ts')), status: 0 }];
  f.api.repositories.push({ rootUri: uri(roots[1].path), state: { indexChanges: [{ uri: uri(path.join(roots[1].path, 'same.ts')), status: 0 }], workingTreeChanges: [], mergeChanges: [] } });
  const separated = adapter.observe(roots, graph);
  assert.equal(separated.rows.length, 2); assert.notEqual(separated.rows[0].repoId, separated.rows[1].repoId);
  assert.notEqual(separated.rows[0].file?.rootId, separated.rows[1].file?.rootId);
});
