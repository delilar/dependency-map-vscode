import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace, AnalyzerSession } from '../../src/analysis/index';
import type { GraphSnapshot } from '../../src/shared/model';
import { frameworkProfile } from '../../src/analysis/framework-profile';

async function fixture(entries: Record<string, string>, run: (directory: string, analyze: () => Promise<GraphSnapshot>) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-resolver-audit-'));
  try {
    for (const [relative, text] of Object.entries(entries)) {
      const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    await run(directory, () => analyzeWorkspace([{ id: 'audit', name: 'audit', path: directory }], { exclude: [] }, []));
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-resolver-audit-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const targetPaths = (graph: GraphSnapshot, source: string) => graph.relations.filter(edge => graph.nodes.find(node => node.id === edge.sourceId)?.file?.path === source)
  .map(edge => graph.nodes.find(node => node.id === edge.targetId)?.file?.path).filter(Boolean).sort();

test('framework profiles require one bounded known major instead of guessing complex ranges', () => {
  for (const version of ['3', '3.0', '3.0.0', '^3.0.0', '~3.5.1', '=3.0.0']) assert.deepEqual(frameworkProfile({ dependencies: { nuxt: version } }, 'nuxt', [3, 4]), { status: 'supported', major: 3 });
  for (const version of ['*', 'workspace:*', '^3.0.0 || ^4.0.0', '>=3', '3.x', '3.0.0-beta.1', '03.0.0']) assert.deepEqual(frameworkProfile({ dependencies: { nuxt: version } }, 'nuxt', [3, 4]), { status: 'unknown' });
  assert.deepEqual(frameworkProfile({ dependencies: { nuxt: '2.17.0' } }, 'nuxt', [3, 4]), { status: 'unsupported', major: 2 });
  assert.deepEqual(frameworkProfile({ dependencies: { nuxt: '3.0.0' }, devDependencies: { nuxt: '4.0.0' } }, 'nuxt', [3, 4]), { status: 'unknown' });
  assert.deepEqual(frameworkProfile({}, 'nuxt', [3, 4]), { status: 'absent' });
  assert.deepEqual(frameworkProfile({ peerDependencies: { nuxt: '^3.0.0' } }, 'nuxt', [3, 4]), { status: 'supported', major: 3 });
  assert.deepEqual(frameworkProfile({ optionalDependencies: { nuxt: '*' } }, 'nuxt', [3, 4]), { status: 'unknown' });
  assert.deepEqual(frameworkProfile({ dependencies: { nuxt: '3.0.0' }, peerDependencies: { nuxt: '^4.0.0' } }, 'nuxt', [3, 4]), { status: 'unknown' });
});

test('application aliases are isolated from test configs and nearest nested config wins', async () => {
  await fixture({
    'package.json': '{"dependencies":{"vite":"6.0.0","vitest":"3.0.0"}}',
    'vite.config.ts': 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"src")}}};',
    'vitest.config.ts': 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"test-stubs")}}};',
    'nested/vite.config.ts': 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"local")}}};',
    'src/main.ts': 'import {value} from "@/value";', 'src/value.ts': 'export const value=1;',
    'main.test.ts': 'import {value} from "@/value";', 'test-stubs/value.ts': 'export const value=2;',
    'nested/main.ts': 'import {value} from "@/value";', 'nested/local/value.ts': 'export const value=3;'
  }, async (_directory, analyze) => {
    const graph = await analyze();
    assert.deepEqual(targetPaths(graph, 'src/main.ts'), ['src/value.ts']);
    assert.deepEqual(targetPaths(graph, 'main.test.ts'), ['test-stubs/value.ts']);
    assert.deepEqual(targetPaths(graph, 'nested/main.ts'), ['nested/local/value.ts']);
    const main = graph.nodes.find(node => node.file?.path === 'src/main.ts')!;
    assert(graph.diagnostics.some(row => row.fileId === main.id && /application\/test entry context/.test(row.message)));
    assert(graph.coverage?.find(row => row.fileId === main.id)?.reasonCodes.includes('parseDiagnostic'), 'Different entry contexts cannot claim complete universal source semantics');
  });
});

test('duplicate application configs stay ambiguous instead of using inventory order', async () => {
  await fixture({
    'package.json': '{"dependencies":{"vite":"6.0.0"}}',
    'vite.config.ts': 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"one")}}};',
    'vite.config.js': 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"two")}}};',
    'main.ts': 'import {value} from "@/value"; import "./plain";',
    'plain.ts': 'export {};', 'one/value.ts': 'export const value=1;', 'two/value.ts': 'export const value=2;'
  }, async (_directory, analyze) => {
    const graph = await analyze();
    assert.deepEqual(targetPaths(graph, 'main.ts'), ['plain.ts']);
    assert(graph.unresolved.some(row => row.expression === '@/value'));
    assert(graph.diagnostics.some(row => /config.*ambiguous|ambiguous.*config/i.test(row.message)));
  });
});

test('Vite root URLs distinguish source files from public assets and collisions', async () => {
  await fixture({
    'package.json': '{"dependencies":{"vite":"6.0.0"}}',
    'vite.config.ts': 'export default {root:"site",publicDir:"static"};',
    'site/index.html': '<script type="module" src="/src/main.ts"></script><img src="/icon.svg"><img src="/collision.svg"><img src="/../outside.svg">',
    'site/src/main.ts': 'import {value} from "/src/value";', 'site/src/value.ts': 'export const value=1;', 'site/static/icon.svg': '<svg/>',
    'site/collision.svg': '<svg/>', 'site/static/collision.svg': '<svg/>', 'outside.svg': '<svg/>'
  }, async (_directory, analyze) => {
    const graph = await analyze();
    assert.deepEqual(targetPaths(graph, 'site/index.html'), ['site/src/main.ts', 'site/static/icon.svg']);
    assert.deepEqual(targetPaths(graph, 'site/src/main.ts'), ['site/src/value.ts']);
    assert(graph.unresolved.some(row => row.expression === '/collision.svg'));
  });
});

test('Nuxt aliases belong to a supported Nuxt profile rather than a neighboring Vite config', async () => {
  for (const version of ['3.0.0', '4.0.0', '*', '2.17.0', '^3.0.0 || ^4.0.0']) await fixture({
    'package.json': JSON.stringify({ dependencies: { nuxt: version, vite: '6.0.0' } }),
    'nuxt.config.ts': 'export default defineNuxtConfig({srcDir:"app"});',
    'vite.config.ts': 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"stubs")}}};',
    'app/main.ts': 'import {value} from "@/value"; import "./plain";',
    'app/value.ts': 'export const value=1;', 'app/plain.ts': 'export {};', 'stubs/value.ts': 'export const value=2;'
  }, async (_directory, analyze) => {
    const graph = await analyze();
    assert.deepEqual(targetPaths(graph, 'app/main.ts'), ['3.0.0', '4.0.0'].includes(version) ? ['app/plain.ts', 'app/value.ts'] : ['app/plain.ts'], version);
  });
});

test('Vite absolute glob patterns use the configured root and unknown profiles are explicit', async () => {
  for (const version of ['6.0.0', '*']) await fixture({
    'package.json': JSON.stringify({ dependencies: { vite: version } }),
    'vite.config.ts': 'export default {root:"site"};',
    'site/main.ts': 'const modules=import.meta.glob("/parts/*.ts");',
    'site/parts/one.ts': 'export const one=1;', 'parts/two.ts': 'export const two=2;'
  }, async (_directory, analyze) => {
    const graph = await analyze();
    assert.deepEqual(targetPaths(graph, 'site/main.ts'), version === '6.0.0' ? ['site/parts/one.ts'] : []);
    if (version === '*') assert(graph.diagnostics.some(row => /known compatible/.test(row.message)));
  });
});

test('config edits refresh complete contributions and keep aliases isolated in two roots', async () => {
  await fixture({
    'one/package.json': '{"dependencies":{"vite":"6.0.0"}}',
    'one/vite.config.ts': 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"src")}}};',
    'one/main.ts': 'import Card from "@/Card.vue";',
    'one/src/Card.vue': '<script>export const one=1;</script><template/>',
    'one/other/Card.vue': '<script>export const two=2;</script><template/>',
    'two/package.json': '{"dependencies":{"vite":"6.0.0"}}',
    'two/vite.config.ts': 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"src")}}};',
    'two/main.ts': 'import Card from "@/Card.vue";',
    'two/src/Card.vue': '<template/>'
  }, async directory => {
    const roots = ['one', 'two'].map(id => ({ id, name: id, path: path.join(directory, id) }));
    const session = new AnalyzerSession();
    const before = await session.analyze(roots, { exclude: [] }, []);
    const targets = (graph: GraphSnapshot, rootId: string) => graph.relations.filter(edge => graph.nodes.find(node => node.id === edge.sourceId)?.file?.rootId === rootId && graph.nodes.find(node => node.id === edge.sourceId)?.file?.path === 'main.ts').map(edge => graph.nodes.find(node => node.id === edge.targetId)?.file);
    assert.deepEqual(targets(before, 'one'), [{ rootId: 'one', path: 'src/Card.vue' }]);
    assert.deepEqual(targets(before, 'two'), [{ rootId: 'two', path: 'src/Card.vue' }]);
    const config = path.join(directory, 'one/vite.config.ts');
    fs.writeFileSync(config, 'import path from "node:path"; export default {resolve:{alias:{"@":path.resolve(__dirname,"other")}}};');
    const incremental = await session.analyze(roots, { exclude: [] }, [], undefined, [config]);
    const full = await analyzeWorkspace(roots, { exclude: [] }, []);
    for (const key of ['relations', 'exports', 'bindingOccurrences', 'declarations', 'coverage', 'coverageReasons', 'unresolved'] as const) assert.deepEqual(incremental[key], full[key], key);
    assert.deepEqual(targets(incremental, 'one'), [{ rootId: 'one', path: 'other/Card.vue' }]);
    assert.deepEqual(targets(incremental, 'two'), [{ rootId: 'two', path: 'src/Card.vue' }]);
  });
});
