import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace, AnalyzerSession } from '../../src/analysis/index';
import type { GraphSnapshot, SourceOverlay, WorkspaceRoot } from '../../src/shared/model';
import { GraphQueryIndex } from '../../src/analysis/graph-query-index';
import { executeQuery } from '../../src/analysis/graph-queries';
import { queryLimits } from '../../src/shared/query-model';
import { scopeSignature, type ScopeSpec } from '../../src/shared/scope';

async function fixture(run: (directory: string, put: (name: string, text: string) => void) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-lifecycle-'));
  const put = (name: string, text: string) => { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  try { await run(directory, put); }
  finally {
    const relative = path.relative(os.tmpdir(), directory);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-lifecycle-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const normalized = (graph: GraphSnapshot) => Object.fromEntries(
  (['nodes', 'relations', 'unresolved', 'diagnostics', 'exports', 'bindingOccurrences', 'declarations', 'coverage', 'coverageReasons', 'physicalFileIds'] as const)
    .map(key => [key, (graph[key] ?? []).map(row => JSON.stringify(row)).sort()]),
);

test('dirty Vue edits, missing targets, rename and overlay close match full symbol/capability snapshots', async () => {
  await fixture(async (directory, put) => {
    const roots = [{ id: 'app', name: 'app', path: directory }];
    put('package.json', '{"name":"app"}');
    const component = (target: string) => `<script lang="ts">\r\n// 🙂\r\nimport {value} from "./${target}";\r\nexport const version=value;\r\nexport default {};\r\n</script><template><div/></template>`;
    put('Card.vue', component('one')); put('one.ts', 'export const value=1;'); put('two.ts', 'export const value=2;');
    put('barrel.ts', 'export {default as Card,version} from "./Card.vue";');
    put('main.ts', 'import {Card,version} from "./barrel"; export const current=version;');
    const session = new AnalyzerSession();
    async function check(overlays: SourceOverlay[], changes?: string[]) {
      const graph = await session.analyze(roots, { exclude: [] }, overlays, undefined, changes);
      assert.deepEqual(normalized(graph), normalized(await analyzeWorkspace(roots, { exclude: [] }, overlays)));
      return graph;
    }
    const target = (graph: GraphSnapshot, suffix: string) => graph.nodes.find(node => node.file?.path === suffix)!.id;
    const baseline = await check([]);
    assert(baseline.declarations?.some(row => row.imported === 'Card' && row.file.path === 'Card.vue'));
    const dirty = [{ path: path.join(directory, 'Card.vue'), version: 1, text: component('two') }];
    const edited = await check(dirty);
    assert(edited.relations.some(edge => edge.sourceId === target(edited, 'Card.vue') && edge.targetId === target(edited, 'two.ts')));
    assert(!edited.relations.some(edge => edge.sourceId === target(edited, 'Card.vue') && edge.targetId === target(edited, 'one.ts')));
    fs.renameSync(path.join(directory, 'two.ts'), path.join(directory, 'three.ts'));
    const missing = await check(dirty, [path.join(directory, 'two.ts'), path.join(directory, 'three.ts')]);
    assert(missing.unresolved.some(row => row.sourceId === target(missing, 'Card.vue') && row.expression === './two'));
    assert(!missing.nodes.some(node => node.file?.path === 'two.ts'));
    const renamed = await check([{ ...dirty[0], version: 2, text: component('three') }]);
    assert(renamed.relations.some(edge => edge.sourceId === target(renamed, 'Card.vue') && edge.targetId === target(renamed, 'three.ts')));
    const closed = await check([]);
    assert(closed.relations.some(edge => edge.sourceId === target(closed, 'Card.vue') && edge.targetId === target(closed, 'one.ts')));
    assert.deepEqual(fs.readFileSync(path.join(directory, 'Card.vue'), 'utf8'), component('one'), 'overlays never rewrite the physical source');
  });
});

test('same SFC alias in two open roots resolves to separate physical declarations', async () => {
  await fixture(async (directory, put) => {
    const roots: WorkspaceRoot[] = ['one', 'two'].map(id => ({ id, name: id, path: path.join(directory, id) }));
    for (const root of roots) {
      put(`${root.id}/package.json`, JSON.stringify({ name: root.id }));
      put(`${root.id}/tsconfig.json`, '{"compilerOptions":{"baseUrl":".","paths":{"@ui/*":["src/*"]}}}');
      put(`${root.id}/src/Card.vue`, '<template><div/></template>');
      put(`${root.id}/src/main.ts`, 'import Card from "@ui/Card.vue"; export {Card};');
    }
    const graph = await analyzeWorkspace(roots, { exclude: [] }, []);
    for (const root of roots) {
      const source = graph.nodes.find(node => node.file?.rootId === root.id && node.file.path === 'src/main.ts')!;
      const target = graph.nodes.find(node => node.file?.rootId === root.id && node.file.path === 'src/Card.vue')!;
      const edge = graph.relations.find(row => row.sourceId === source.id && row.specifier === '@ui/Card.vue')!;
      assert.equal(edge.targetId, target.id);
      assert(graph.declarations?.some(row => row.relationId === edge.id && row.file.rootId === root.id && row.file.path === 'src/Card.vue'));
    }
  });
});

test('mixed Next and unknown Nuxt roots keep profile uncertainty inside the analytical boundary', async () => {
  await fixture(async (directory, put) => {
    const roots = ['next', 'nuxt'].map(id => ({ id, name: id, path: path.join(directory, id) }));
    put('next/package.json', '{"name":"web-next","dependencies":{"next":"16.0.0"}}');
    put('next/app/layout.tsx', 'export default function Layout() {}');
    put('next/app/page.tsx', 'import {value} from "../value"; export default function Page(){return value;}');
    put('next/value.ts', 'export const value=1;');
    put('nuxt/package.json', '{"name":"web-nuxt","dependencies":{"nuxt":"*"}}');
    put('nuxt/pages/index.vue', '<template>{{useCart()}}</template>');
    put('nuxt/composables/useCart.ts', 'export function useCart(){return 1;}');
    const graph = await analyzeWorkspace(roots, { exclude: [] }, []);
    const file = (rootId: string, name: string) => graph.nodes.find(node => node.file?.rootId === rootId && node.file.path === name)!;
    assert(graph.relations.some(edge => edge.sourceId === file('next', 'app/page.tsx').id && edge.targetId === file('next', 'app/layout.tsx').id && edge.kind === 'framework' && edge.certainty === 'confirmed'));
    assert(!graph.relations.some(edge => edge.sourceId === file('nuxt', 'pages/index.vue').id && edge.kind === 'framework' && edge.certainty === 'confirmed'));
    async function impact(scope?: ScopeSpec) {
      return executeQuery(new GraphQueryIndex(graph), { type: 'query', apiVersion: 1, requestId: 'profiles', graph: { epoch: 'profiles', revision: graph.revision, scopeRevision: 0 }, scope, queryScopeSignature: scopeSignature(scope), limits: queryLimits, query: { kind: 'impact', seeds: [file('next', 'value.ts').id], depth: 3, includeTypes: true, includeInferred: false } });
    }
    assert.equal((await impact()).coverage, 'partial');
    const scoped = await impact({ version: 1, folders: [{ rootId: 'next', path: '.' }], excludeRoles: [] });
    assert.equal(scoped.coverage, 'complete');
    assert(scoped.nodeIds.includes(file('next', 'app/page.tsx').id));
  });
});
