import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRootBindings } from '../../src/host/root-bindings';

test('explicit rebind wins over a previous mapping regardless of folder order', () => {
  const roots = [{ id: 'saved-web', name: 'first', path: '/first' }, { id: 'temporary', name: 'second', path: '/second' }];
  const bound = applyRootBindings(roots, ['saved-web'], { 'saved-web': '/second' });
  assert.equal(bound[1].id, 'saved-web');
  assert.notEqual(bound[0].id, 'saved-web');
  assert.equal(roots[0].id, 'saved-web');
});

test('leaving saved roots unbound removes an old mapping and rejects duplicate or foreign folders', () => {
  const roots = [{ id: 'web', name: 'web', path: '/web' }];
  assert.notEqual(applyRootBindings(roots, ['web'], {})[0].id, 'web');
  assert.throws(() => applyRootBindings(roots, ['a', 'b'], { a: '/web', b: '/web' }));
  assert.throws(() => applyRootBindings(roots, ['a'], { a: '/other' }));
});
