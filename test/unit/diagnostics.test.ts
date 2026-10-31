import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnostics, formatDiagnostics } from '../../src/host/diagnostics';
import { emptyGraph } from '../../src/shared/model';
import type { BuildIdentity, IndexState, RuntimeState } from '../../src/shared/query-model';

const build: BuildIdentity = { extensionVersion: '0.2.0', buildId: '1234567890abcdef', protocolVersion: 2, capabilities: ['queries', 'git'] };
const runtime: RuntimeState = { host: build, worker: build, webview: build, installedVersion: '0.2.0', compatible: true, reasonCodes: [] };
const index: IndexState = { state: 'ready', version: { epoch: 'private-epoch', revision: 8, scopeRevision: 2 }, reasonCodes: ['cachedProviderState'] };

test('diagnostic report contains allowlisted versions, counters and states with no source/paths/Git data', () => {
  const graph = emptyGraph();
  graph.stats = { files: 7, relations: 2, elapsedMs: 123.5 };
  graph.diagnostics = [{ message: 'C:/PRIVATE_PROJECT/API_KEY_VALUE' }];
  graph.nodes = [{ id: 'private-id', kind: 'file', label: 'PRIVATE_SOURCE', file: { rootId: 'private-root', path: 'private/path.ts' }, projectId: 'private-project', format: '.ts' }];
  const input = { runtime, index, graph, git: { gitRevision: 3, providerState: 'available' as const, observedAt: 200, repositories: [{ id: 'repo:private', label: 'PRIVATE_REPO', state: 'available' as const }], rows: [{ id: 'private-change', repoId: 'repo:private', relativePath: '.env.local', staged: true, unstaged: false, untracked: false, conflict: false, dirty: true, scopeStatus: 'unindexed' as const }], omissions: 1, reasonCodes: ['cachedProviderState'] } };
  const report = createDiagnostics(input);
  const text = formatDiagnostics(input);
  assert.equal(report.schemaVersion, 1);
  assert(text.includes('0.2.0')); assert(text.includes('1234567890abcdef')); assert(text.includes('ready'));
  assert(text.includes('cachedProviderState'));
  for (const privatePart of ['PRIVATE', 'API_KEY_VALUE', 'private-epoch', 'private/path.ts', '.env.local', 'repo:private', 'private-id']) assert(!text.includes(privatePart), privatePart);
  assert.deepEqual(JSON.parse(text), report);
});

test('diagnostics reject arbitrary reason text and build strings and sanitize invalid numeric counters', () => {
  const input = { runtime: { ...runtime, host: { ...build, buildId: 'C:/PRIVATE', extensionVersion: 'API_KEY_VALUE', capabilities: ['PRIVATE_CAPABILITY'] }, reasonCodes: ['API_KEY_VALUE', 'C:/PRIVATE', 'webviewMismatch'] }, index: { ...index, reasonCodes: ['C:/PRIVATE', 'indexChanged'] }, graph: { ...emptyGraph(), stats: { files: Infinity, relations: -1, elapsedMs: NaN } } };
  const text = formatDiagnostics(input);
  assert(!text.includes('PRIVATE')); assert(!text.includes('API_KEY_VALUE')); assert(text.includes('webviewMismatch')); assert(text.includes('indexChanged'));
  assert(!text.includes('Infinity')); assert(!text.includes('NaN'));
});
