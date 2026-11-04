import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace } from '../../src/analysis/index';
import { exportTables, resolveExport } from '../../src/analysis/export-resolution';
import { scopedGraph } from '../../src/shared/scope';
import type { GraphSnapshot, WorkspaceRoot } from '../../src/shared/model';

async function fixture(entries: Record<string, string>, run: (value: { directory: string; roots: WorkspaceRoot[]; analyze(): Promise<GraphSnapshot> }) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-web-review-'));
  try {
    for (const [relative, text] of Object.entries(entries)) {
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    const roots = [{ id: 'review', name: 'review', path: directory }];
    await run({ directory, roots, analyze: () => analyzeWorkspace(roots, { exclude: [] }, []) });
  } finally {
    const target = path.resolve(directory), relative = path.relative(path.resolve(os.tmpdir()), target);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(target).startsWith('dependency-map-web-review-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
const node = (graph: GraphSnapshot, file: string) => {
  const value = graph.nodes.find(candidate => candidate.file?.path === file);
  assert(value, `Missing fixture node ${file}`); return value;
};

test('package conditions and blocked exports never invent a confirmed entry', async () => {
  await fixture({
    'package.json': JSON.stringify({ imports: { '#ambiguous': { browser: './browser.ts', default: './server.ts' }, '#same': { import: './same.ts', default: './same.ts' }, '#blocked': { default: './same.ts', custom: null }, '#customOnly': { custom: './same.ts' } } }),
    'main.ts': 'import "#ambiguous"; import "#same"; import "#blocked"; import "#customOnly"; import "closed"; import "hidden"; import "conditional"; import "same"; import "same/private"; import "escape";',
    'browser.ts': 'export {};', 'server.ts': 'export {};', 'same.ts': 'export {};',
    'packages/closed/package.json': '{"name":"closed","exports":null,"main":"index.ts"}',
    'packages/closed/index.ts': 'export {};',
    'packages/hidden/package.json': '{"name":"hidden","exports":{"./public":"./index.ts"},"main":"index.ts"}',
    'packages/hidden/index.ts': 'export {};',
    'packages/conditional/package.json': '{"name":"conditional","exports":{"browser":"./browser.ts","default":"./index.ts"}}',
    'packages/conditional/browser.ts': 'export {};', 'packages/conditional/index.ts': 'export {};',
    'packages/same/package.json': '{"name":"same","exports":{".":{"import":"./index.ts","default":"./index.ts"}}}',
    'packages/same/index.ts': 'export {};', 'packages/same/private.ts': 'export {};',
    'packages/escape/package.json': '{"name":"escape","exports":"./../same/index.ts","imports":{"#escape":"./../../same.ts"}}',
    'packages/escape/main.ts': 'import "#escape";',
  }, async ({ analyze }) => {
    const graph = await analyze(), main = node(graph, 'main.ts');
    assert.deepEqual(graph.relations.filter(edge => edge.sourceId === main.id && edge.kind === 'import').map(edge => edge.specifier).sort(), ['#same', 'same']);
    for (const specifier of ['#ambiguous', '#blocked', '#customOnly', 'closed', 'hidden', 'conditional', 'same/private', 'escape']) {
      assert(graph.unresolved.some(row => row.sourceId === main.id && row.expression === specifier), specifier);
    }
    assert(graph.unresolved.some(row => row.sourceId === node(graph, 'packages/escape/main.ts').id && row.expression === '#escape'));
  });
});

test('Angular external template cannot reinterpret dotenv values as template source', async () => {
  await fixture({
    'package.json': '{"dependencies":{"@angular/core":"21.0.0"}}',
    'card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<div/>"}) export class Card {}',
    'page.ts': 'import {Component} from "@angular/core"; import {Card} from "./card"; @Component({imports:[Card],templateUrl:"./.env"}) export class Page {}',
    '.env': 'SECRET=<app-card data-private="ENV_TEMPLATE_REVIEW_SENTINEL"/>\n',
  }, async ({ directory, analyze }) => {
    const original = fs.readFileSync;
    const envPath = fs.realpathSync.native(path.join(directory, '.env'));
    let envReads = 0;
    (fs as any).readFileSync = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && path.resolve(args[0]).toLowerCase() === envPath.toLowerCase()) envReads++;
      return original.apply(fs, args as any);
    };
    try {
      const graph = await analyze();
      assert.equal(envReads, 1, 'Only the dedicated keys-only env extractor may read dotenv');
      assert(!graph.relations.some(edge => edge.sourceId === node(graph, '.env').id && edge.targetId === node(graph, 'card.ts').id), 'Env values must not become selector dependencies');
      assert(!JSON.stringify(graph).includes('ENV_TEMPLATE_REVIEW_SENTINEL'));
    } finally { fs.readFileSync = original; }
  });
});

test('Angular selector proof through an outside NgModule is removed from strict Q', async () => {
  await fixture({
    'package.json': '{"dependencies":{"@angular/core":"18.0.1"}}',
    'feature/card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",standalone:false,template:"<div/>"}) export class Card {}',
    'feature/page.ts': 'import {Component} from "@angular/core"; @Component({standalone:false,templateUrl:"./page.html"}) export class Page {}',
    'feature/page.html': '<app-card/>',
    'outside/feature.module.ts': 'import {NgModule} from "@angular/core"; import {Page} from "../feature/page"; import {Card} from "../feature/card"; @NgModule({declarations:[Page,Card],exports:[Card]}) export class FeatureModule {}',
  }, async ({ analyze }) => {
    const graph = await analyze();
    const source = node(graph, 'feature/page.html'), target = node(graph, 'feature/card.ts'), module = node(graph, 'outside/feature.module.ts');
    const relation = graph.relations.find(edge => edge.sourceId === source.id && edge.targetId === target.id && edge.kind === 'framework');
    assert(relation, 'Full index should establish the selector through the NgModule');
    assert(relation.provenanceIds?.includes(module.id), 'The proving registration file is part of provenance');
    const scoped = scopedGraph(graph, { version: 1, folders: [{ rootId: 'review', path: 'feature' }], excludeRoles: [] });
    assert(scoped.nodes.some(candidate => candidate.id === source.id));
    assert(scoped.nodes.some(candidate => candidate.id === target.id));
    assert(!scoped.relations.some(edge => edge.id === relation.id), 'Both endpoints inside Q do not permit an outside registration proof');
  });
});

test('Vite aliases preserve first-defined precedence and refuse invented relative replacements', async () => {
  await fixture({
    'package.json': '{"dependencies":{"vite":"6.0.0"}}',
    'vite.config.ts': 'import {defineConfig} from "vite"; import path from "node:path"; export default defineConfig({resolve:{alias:[{find:"@",replacement:path.resolve(__dirname,"first")},{find:"@/x",replacement:path.resolve(__dirname,"second")},{find:"@relative",replacement:"./relative"}]}});',
    'main.ts': 'import {value} from "@/x/button"; import {other} from "@relative/value";',
    'first/x/button.ts': 'export const value=1;', 'second/button.ts': 'export const value=2;', 'relative/value.ts': 'export const other=3;',
  }, async ({ analyze }) => {
    const graph = await analyze(), main = node(graph, 'main.ts');
    const resolved = graph.relations.filter(edge => edge.sourceId === main.id && edge.kind === 'import');
    assert(resolved.some(edge => edge.targetId === node(graph, 'first/x/button.ts').id));
    assert(!resolved.some(edge => edge.targetId === node(graph, 'second/button.ts').id));
    assert(!resolved.some(edge => edge.targetId === node(graph, 'relative/value.ts').id));
    assert(graph.unresolved.some(reference => reference.sourceId === main.id && reference.expression === '@relative/value'));
  });
});

test('Nuxt virtual imports retain each physical binding and component default through forwarding', async () => {
  await fixture({
    'package.json': '{"dependencies":{"nuxt":"4.0.0","vue":"3.5.0"}}',
    'app/composables/foo.ts': 'export const foo=1;', 'app/composables/bar.ts': 'export const bar=2;',
    'app/consume.ts': 'import {foo,bar} from "#imports"; export const value=foo+bar;',
    'app/forward.ts': 'export {foo,bar} from "#imports";',
    'app/components/Card.vue': '<template><div/></template>',
    'app/component-use.ts': 'import {Card} from "#components"; export {Card};',
  }, async ({ analyze }) => {
    const graph = await analyze(), tables = exportTables(graph);
    const consumer = node(graph, 'app/consume.ts'), forward = node(graph, 'app/forward.ts');
    for (const name of ['foo', 'bar']) {
      const target = node(graph, `app/composables/${name}.ts`);
      const edge = graph.relations.find(edge => edge.sourceId === consumer.id && edge.targetId === target.id && edge.specifier === '#imports');
      assert(edge, `Missing explicit import edge for ${name}`);
      const occurrences = graph.bindingOccurrences?.filter(occurrence => occurrence.relationId === edge.id) ?? [];
      assert.deepEqual(occurrences.map(occurrence => occurrence.imported), [name], 'A virtual import must not attach both bindings to the last target');
      const resolution = resolveExport(tables, forward.id, name, 'value');
      assert.equal(resolution.status, 'resolved');
      assert.deepEqual(resolution.candidates.map(candidate => candidate.fileId), [target.id]);
    }
    const componentUse = node(graph, 'app/component-use.ts'), component = node(graph, 'app/components/Card.vue');
    const resolution = resolveExport(tables, componentUse.id, 'Card', 'value');
    assert.equal(resolution.status, 'resolved');
    assert.deepEqual(resolution.candidates.map(candidate => [candidate.fileId, candidate.name]), [[component.id, 'default']]);
    const edge = graph.relations.find(edge => edge.sourceId === componentUse.id && edge.targetId === component.id && edge.specifier === '#components');
    assert(edge); assert(graph.bindingOccurrences?.some(occurrence => occurrence.relationId === edge.id && occurrence.imported === 'default'));
    assert(!graph.unresolved.some(reference => [consumer.id, forward.id, componentUse.id].includes(reference.sourceId) && ['#imports', '#components'].includes(reference.expression ?? '')));
  });
});
