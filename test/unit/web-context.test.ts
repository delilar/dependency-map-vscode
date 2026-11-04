import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readStaticConfig, splitSpecifier } from '../../src/analysis/web-context';

test('extracts known config literals without evaluating plugins, shadowed calls or getters', () => {
  const value = readStaticConfig('/app/vite.config.ts', 'import {defineConfig as cfg} from "vite"; import path from "node:path"; const src = path.resolve(__dirname, "src"); export default cfg({resolve:{alias:{"@":src}},plugins:[danger()],publicDir:"static"});');
  assert.equal(value.value?.resolve?.alias?.['@'], path.resolve('/app/src'));
  assert.equal(value.value?.publicDir, 'static');
  assert(value.partial);
  const shadow = readStaticConfig('/app/vite.config.ts', 'function defineConfig(x) { throw 1; } export default defineConfig({publicDir:"secret"});');
  assert.equal(shadow.value, undefined);
  assert(shadow.partial);
});

test('keeps package imports distinct from URL fragments and preserves loader meaning', () => {
  assert.deepEqual(splitSpecifier('#imports'), { path: '#imports', qualifier: '' });
  assert.deepEqual(splitSpecifier('./icon.svg#symbol'), { path: './icon.svg', qualifier: '#symbol' });
  assert.deepEqual(splitSpecifier('./view.vue?raw'), { path: './view.vue', qualifier: '?raw' });
});

test('branching constant references have a total extraction budget', () => {
  const declarations = ['const a0=[0];', ...Array.from({ length: 25 }, (_, index) => `const a${index + 1}=[a${index},a${index}];`)];
  const result = readStaticConfig('vite.config.ts', declarations.join('') + 'export default {alias:a25};');
  assert(result.partial);
  const pending: unknown[] = [result.value]; let visited = 0;
  while (pending.length) {
    const value = pending.pop(); visited++;
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
    assert(visited <= 10002);
  }
});

test('mutated or escaped object constants and unknown trailing spreads are not treated as immutable config', () => {
  const mutated = readStaticConfig('vite.config.ts', 'const aliases={"@":"/a"}; aliases["@"]="/b"; export default {resolve:{alias:aliases}};');
  assert(mutated.partial); assert.equal(mutated.value?.resolve.alias, undefined);
  const spread = readStaticConfig('vite.config.ts', 'export default {resolve:{alias:{"@":"/a"}},...unknown};');
  assert(spread.partial); assert.equal(spread.value?.resolve, undefined);
  const overridden = readStaticConfig('vite.config.ts', 'export default {...unknown,publicDir:"static"};');
  assert.equal(overridden.value?.publicDir, 'static');
});
