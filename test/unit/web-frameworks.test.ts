import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace, AnalyzerSession } from '../../src/analysis/index';
import { executeQuery } from '../../src/analysis/graph-queries';
import { GraphQueryIndex } from '../../src/analysis/graph-query-index';
import { queryLimits } from '../../src/shared/query-model';

async function fixture(entries: Record<string, string>, run: (value: { graph: Awaited<ReturnType<typeof analyzeWorkspace>>; directory: string }) => void | Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-framework-web-'));
  try {
    for (const [name, text] of Object.entries(entries)) { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
    await run({ directory, graph: await analyzeWorkspace([{ id: 'web', name: 'web', path: directory }], { exclude: [] }, []) });
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-framework-web-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const paths = (graph: Awaited<ReturnType<typeof analyzeWorkspace>>, source: string) => graph.relations.filter(edge => graph.nodes.find(node => node.id === edge.sourceId)?.file?.path === source).map(edge => graph.nodes.find(node => node.id === edge.targetId)?.file?.path);

test('Nuxt local auto-imports respect template shadowing and independent explicit import flags', async () => {
  await fixture({
    'package.json': '{"dependencies":{"nuxt":"^4.0.0","vue":"^3.5.0"}}',
    'app/composables/useCart.ts': 'export function useCart(){ return {}; }',
    'app/components/CartCard.vue': '<template><div/></template>',
    'app/pages/index.vue': '<template><CartCard/>{{useCart()}}<span v-for="useCart in items">{{useCart}}</span></template>',
    'app/explicit.ts': 'import {useCart} from "#imports"; export const cart=useCart();'
  }, async ({ graph }) => {
    assert(paths(graph, 'app/pages/index.vue').includes('app/components/CartCard.vue'));
    assert(paths(graph, 'app/pages/index.vue').includes('app/composables/useCart.ts'));
    assert(paths(graph, 'app/explicit.ts').includes('app/composables/useCart.ts'));
    const composable = graph.nodes.find(node => node.file?.path === 'app/composables/useCart.ts')!;
    const query = await executeQuery(new GraphQueryIndex(graph), { type: 'query', apiVersion: 1, requestId: 'nuxt-symbol', graph: { epoch: 'test', revision: graph.revision, scopeRevision: 0 }, limits: queryLimits, query: { kind: 'symbol', fileId: composable.id, exported: 'useCart', namespace: 'value' } });
    assert(query.nodeIds.some(id => graph.nodes.find(node => node.id === id)?.file?.path === 'app/pages/index.vue'), 'Symbol consumers include proven local auto-imports');
  });
  await fixture({
    'package.json': '{"dependencies":{"nuxt":"3.0.0"}}', 'nuxt.config.ts': 'export default defineNuxtConfig({imports:{autoImport:false},components:false});',
    'composables/useCart.ts': 'export const useCart=()=>1;', 'components/Card.vue': '<template/>',
    'pages/index.vue': '<template><Card/>{{useCart()}}</template>', 'explicit.ts': 'import {useCart} from "#imports";'
  }, ({ graph }) => { assert.equal(paths(graph, 'pages/index.vue').length, 0); assert(paths(graph, 'explicit.ts').includes('composables/useCart.ts')); });
});

test('known test setup and entry fields create config links, while selectors and output descriptors do not', async () => {
  await fixture({
    'package.json': '{"dependencies":{"vitest":"^3.0.0","webpack":"^5.0.0"}}',
    'vitest.config.ts': 'import {defineConfig} from "vitest/config"; export default defineConfig({test:{setupFiles:["src/setup.ts"],include:["**/*.test.ts"]}});',
    'webpack.config.ts': 'export default {entry:{app:{import:"./src/main.ts",runtime:"./runtime.ts",filename:"out.js"}}};',
    'src/setup.ts': 'export const setup=1;', 'src/main.ts': 'export const app=1;', 'src/example.test.ts': 'export const test=1;', 'runtime.ts': 'export const runtime=1;', 'out.js': 'export const out=1;'
  }, ({ graph }) => {
    assert(paths(graph, 'vitest.config.ts').includes('src/setup.ts'));
    assert(!paths(graph, 'vitest.config.ts').includes('src/example.test.ts'));
    assert.deepEqual(paths(graph, 'webpack.config.ts'), ['src/main.ts']);
  });
});

test('Next private/API routes do not inherit UI wrappers and pageExtensions controls pages', async () => {
  await fixture({
    'package.json': '{"dependencies":{"next":"^16.0.0"}}', 'next.config.ts': 'export default {pageExtensions:["page.tsx","tsx"]};',
    'pages/_app.tsx': 'export default function App(){}', 'pages/index.tsx': 'export default function Page(){}', 'pages/api/data.ts': 'export default function Handler(){}',
    'app/layout.tsx': 'export default function Layout(){}', 'app/page.tsx': 'export default function Page(){}', 'app/_private/page.tsx': 'export default function Page(){}',
    'app/api/route.ts': 'export function GET(){}'
  }, ({ graph }) => {
    assert(paths(graph, 'pages/index.tsx').includes('pages/_app.tsx'));
    assert.equal(paths(graph, 'pages/api/data.ts').length, 0);
    assert(paths(graph, 'app/page.tsx').includes('app/layout.tsx'));
    assert.equal(paths(graph, 'app/_private/page.tsx').length, 0); assert.equal(paths(graph, 'app/api/route.ts').length, 0);
  });
});

test('SvelteKit page loaders and layout relationships are distinct from server endpoints', async () => {
  await fixture({
    'package.json': '{"dependencies":{"@sveltejs/kit":"^2.0.0"}}',
    'src/routes/+layout.svelte': '<slot/>', 'src/routes/(shop)/+page.svelte': '<div/>', 'src/routes/(shop)/+page.ts': 'export const load=()=>({});',
    'src/routes/(shop)/+page.server.ts': 'export const load=()=>({});', 'src/routes/(shop)/+server.ts': 'export function GET(){}'
  }, ({ graph }) => { assert.deepEqual(paths(graph, 'src/routes/(shop)/+page.svelte').sort(), ['src/routes/(shop)/+page.server.ts', 'src/routes/(shop)/+page.ts', 'src/routes/+layout.svelte'].sort()); assert.equal(paths(graph, 'src/routes/(shop)/+server.ts').length, 0); });
});

test('Angular selector use is constrained by standalone imports and NgModule exports', async () => {
  await fixture({
    'package.json': '{"dependencies":{"@angular/core":"^21.0.0"}}',
    'card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<div/>"}) export class Card {}',
    'other.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<div/>"}) export class Other {}',
    'page.ts': 'import {Component as C} from "@angular/core"; import {Card} from "./card"; @C({imports:[Card],templateUrl:"./page.html",styleUrls:["./page.css"]}) export class Page {}',
    'page.html': '<app-card/>', 'page.css': 'div {}'
  }, ({ graph }) => { assert(paths(graph, 'page.html').includes('card.ts')); assert(!paths(graph, 'page.html').includes('other.ts')); assert(paths(graph, 'page.ts').includes('page.css')); });
});

test('GraphQL resolves fragments only in an explicit document set and reports ambiguous names', async () => {
  await fixture({
    'package.json': '{"dependencyMap":{"graphqlDocuments":["api/*.graphql"]}}',
    'api/query.graphql': 'query Q { user {...User} }', 'api/user.graphql': 'fragment User on User {id}', 'elsewhere/user.graphql': 'fragment User on User {name}'
  }, ({ graph }) => { assert.deepEqual(paths(graph, 'api/query.graphql'), ['api/user.graphql']); });
});

test('framework registrations match a clean rebuild after a new auto-import target is created', async () => {
  await fixture({ 'package.json': '{"dependencies":{"nuxt":"4.0.0"}}', 'app/pages/index.vue': '<template>{{useCart()}}</template>' }, async ({ directory }) => {
    const roots = [{ id: 'web', name: 'web', path: directory }]; const session = new AnalyzerSession(); await session.analyze(roots, { exclude: [] }, []);
    fs.mkdirSync(path.join(directory, 'app/composables')); const file = path.join(directory, 'app/composables/useCart.ts'); fs.writeFileSync(file, 'export const useCart=()=>1;');
    const incremental = await session.analyze(roots, { exclude: [] }, [], undefined, [file]); const full = await analyzeWorkspace(roots, { exclude: [] }, []);
    assert.deepEqual(incremental.relations.map(edge => edge.id).sort(), full.relations.map(edge => edge.id).sort());
    assert(paths(incremental, 'app/pages/index.vue').includes('app/composables/useCart.ts'));
  });
});
