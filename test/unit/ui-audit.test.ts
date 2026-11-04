import assert from 'node:assert/strict';
import test from 'node:test';
import { describeScope, describeScopeSignature } from '../../src/webview/scope-description';
import type { GraphNode } from '../../src/shared/model';

test('scope descriptions use project names and tolerate unavailable or malformed signatures', () => {
  const nodes: GraphNode[] = [{ id: 'file:opaque-id:a.ts', label: 'a.ts', kind: 'file', projectId: 'project-uuid', projectName: 'Shop', format: '.ts', file: { rootId: 'opaque-id', path: 'feature/a.ts' } }];
  const scope = { version: 1 as const, folders: [{ rootId: 'opaque-id', path: 'feature' }], excludeRoles: [] };
  assert.equal(describeScope(scope, nodes), 'Shop/feature');
  assert.equal(describeScopeSignature(JSON.stringify(scope), nodes), 'Shop/feature');
  assert.equal(describeScopeSignature('invalid-private-id', nodes), 'ограниченная область');
  assert.equal(describeScopeSignature('all', nodes), 'весь индекс');
  assert.equal(describeScope({ ...scope, folders: [{ rootId: 'closed-root', path: '.' }] }, nodes), 'недоступный корень/.');
});
