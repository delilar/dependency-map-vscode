import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace } from '../../src/analysis/index';
import { extractJavascript } from '../../src/analysis/javascript';
import { extractComponent } from '../../src/analysis/components';
import { extractResources } from '../../src/analysis/resources';
import type { GraphSnapshot } from '../../src/shared/model';

async function fixture(entries: Record<string, string>, run: (directory: string, graph: () => Promise<GraphSnapshot>) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-adapter-audit-'));
  try {
    for (const [name, text] of Object.entries(entries)) { const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
    await run(directory, () => analyzeWorkspace([{ id: 'audit', name: 'audit', path: directory }], { exclude: [] }, []));
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-adapter-audit-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const node = (graph: GraphSnapshot, name: string) => graph.nodes.find(item => item.file?.path === name)!;
const angular = {
  'package.json': '{"dependencies":{"@angular/core":"21.0.0"}}',
  'card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<div></div>"}) export class Card {}',
  'highlight.ts': 'import {Directive} from "@angular/core"; @Directive({selector:"[highlight]"}) export class Highlight {}',
  'page.ts': 'import {Component} from "@angular/core"; import {Card} from "./card"; import {Highlight} from "./highlight"; @Component({imports:[Card,Highlight],templateUrl:"./page.html"}) export class Page {}',
  'page.html': '<app-card highlight></app-card>',
};

test('Angular component and directives on one element are independent usages; conflicting components remain ambiguous', async () => {
  await fixture(angular, async (_, analyze) => {
    const graph = await analyze();
    const edges = graph.relations.filter(edge => edge.sourceId === node(graph, 'page.html').id && edge.kind === 'framework');
    assert.deepEqual(edges.map(edge => graph.nodes.find(item => item.id === edge.targetId)?.file?.path).sort(), ['card.ts', 'highlight.ts']);
    assert(!graph.diagnostics.some(item => item.message.includes('ambiguous declarations')));
  });
  await fixture({ ...angular, 'other.ts': angular['card.ts'].replaceAll('Card', 'Other'), 'page.ts': angular['page.ts'].replace('imports:[Card,Highlight]', 'imports:[Card,Highlight,Other]') + '\nimport {Other} from "./other";' }, async (_, analyze) => {
    const graph = await analyze();
    assert(graph.diagnostics.some(item => item.message.includes('ambiguous declarations')));
    assert(!graph.relations.some(edge => edge.sourceId === node(graph, 'page.html').id && edge.targetId === node(graph, 'card.ts').id && edge.kind === 'framework'));
  });
});

test('Angular reads one physical template a bounded number of times for 1000 selector occurrences', async () => {
  await fixture({ ...angular, 'page.html': '<app-card></app-card>\n'.repeat(1000) }, async (directory, analyze) => {
    const physical = path.resolve(directory, 'page.html'), original = fs.readFileSync;
    let reads = 0;
    (fs as any).readFileSync = (...args: unknown[]) => { if (typeof args[0] === 'string' && path.resolve(args[0]) === physical) reads++; return original.apply(fs, args as any); };
    try {
      const graph = await analyze();
      assert(reads <= 4, `Expected bounded reads, got ${reads}`);
      const edge = graph.relations.find(edge => edge.sourceId === node(graph, 'page.html').id && edge.targetId === node(graph, 'card.ts').id && edge.kind === 'framework');
      assert(edge?.evidence.some(item => item.range?.start.line === 999), 'Late physical source positions remain available');
    } finally { fs.readFileSync = original; }
  });
});

test('GraphQL collection overflow cannot silently drop a negative selector', async () => {
  const patterns = ['*.graphql', ...Array.from({ length: 29 }, (_, i) => `unused-${i}/*.graphql`), '!fragment.graphql'];
  await fixture({ 'package.json': JSON.stringify({ dependencyMap: { graphqlDocuments: patterns } }), 'query.graphql': 'query Q {user {...User}}', 'fragment.graphql': 'fragment User on User {id}' }, async (_, analyze) => {
    const graph = await analyze();
    assert(!graph.relations.some(edge => edge.specifier === 'User'));
    assert(graph.diagnostics.some(item => /collection.*limit|collection.*invalid/i.test(item.message)));
    assert(graph.coverage?.find(item => item.fileId === node(graph, 'query.graphql').id)?.reasonCodes.includes('frameworkLimited'));
  });
});

test('GraphQL counts fragment declaration identities including duplicates in the same file', async () => {
  await fixture({ 'package.json': '{"dependencyMap":{"graphqlDocuments":["*.graphql"]}}', 'query.graphql': 'query Q {user {...User}}', 'fragment.graphql': 'fragment User on User {id}\nfragment User on User {name}' }, async (_, analyze) => {
    const graph = await analyze();
    assert(!graph.relations.some(edge => edge.specifier === 'User'));
    assert(graph.diagnostics.some(item => item.message.includes('ambiguous')));
  });
  const negatives: Record<string, string>[] = [{}, { 'one.graphql': 'fragment User on User {id}', 'two.graphql': 'fragment User on User {name}' }];
  for (const extra of negatives) {
    await fixture({ 'package.json': '{"dependencyMap":{"graphqlDocuments":["*.graphql"]}}', 'query.graphql': 'query Q {user {...User}}', ...extra }, async (_, analyze) => {
      const graph = await analyze(), source = node(graph, 'query.graphql');
      assert(!graph.relations.some(edge => edge.sourceId === source.id && edge.specifier === 'User'));
      assert(graph.diagnostics.some(item => item.fileId === source.id && item.message.includes('missing or ambiguous')));
    });
  }
});

test('loop lexical bindings shadow require and process without suppressing outer primitives', () => {
  const result = extractJavascript('loops.ts', 'for (const require of funcs) {require("./not-import");} for (const {process} of objects) {process.env.NOT_ENV;} for (let require=fn;cond;) {require("./also-not-import");} require("./real");');
  assert.deepEqual(result.references.filter(item => item.kind === 'import').map(item => item.specifier), ['./real']);
  assert(!result.references.some(item => item.kind === 'environment'));
  const hoisted = extractJavascript('loop-vars.ts', 'function f(){require("./not-import"); for (var require of funcs) {} } require("./outer");');
  assert.deepEqual(hoisted.references.filter(item => item.kind === 'import').map(item => item.specifier), ['./outer']);
});

test('mutated and escaped Tramvai options never reuse stale initial modules', () => {
  for (const mutation of ['options.modules=[B];', 'const alias=options; alias.modules=[B];', 'change(options);', 'options.modules.push(B);', 'delete options.modules;', 'const nested=options.modules; nested.push(B);']) {
    const result = extractJavascript('app.ts', `import {createApp} from "@tramvai/core"; import {A} from "./a"; import {B} from "./b"; const options={modules:[A]}; ${mutation} createApp(options);`);
    assert(!result.references.some(item => item.kind === 'framework' && /createApp.modules/.test(item.evidence.rule)), mutation);
    assert(result.diagnostics.length || result.references.some(item => item.reason), mutation);
  }
  const positive = extractJavascript('app.ts', 'import {createApp} from "@tramvai/core"; import {A} from "./a"; const modules=[A]; const options={modules}; createApp(options);');
  assert(positive.references.some(item => item.kind === 'framework' && item.bindings[0]?.imported === 'A'));
  const spread = extractJavascript('spread.ts', 'import {createApp} from "@tramvai/core"; import {A} from "./a"; const options={modules:[A],...unknown}; createApp(options);');
  assert(!spread.references.some(item => item.kind === 'framework'));
  assert(spread.diagnostics.length);
});

test('Vue and Svelte native resources differ from arbitrary component props', async () => {
  for (const extension of ['vue', 'svelte']) {
    const script = extension === 'vue' ? '<script setup>import Card from "./Card.vue";</script>' : '<script>import Card from "./Card.svelte";</script>';
    const markup = '<Card src="./fake.png" href="./fake.svg"/><Link href="./fake-link.html"/><Img src="./fake-image.png"/><img src="./real.png" srcset="./small.png 1x, ./large.png 2x"/><video poster="./poster.png"/><svg><image href="./vector.svg"/></svg>';
    const result = await extractComponent(`main.${extension}`, script + (extension === 'vue' ? `<template>${markup}</template>` : markup));
    assert(result);
    const refs = result.references.filter(item => item.kind === 'resource').map(item => item.specifier);
    assert(!refs.some(name => name?.startsWith('./fake')), extension);
    assert(refs.includes('./real.png') && refs.includes('./poster.png') && refs.includes('./vector.svg'), extension);
    assert(refs.includes('./small.png') && refs.includes('./large.png'), extension);
  }
});

test('JSX and HTML retain native SVG/srcset resources without interpreting component props', () => {
  const jsx = extractJavascript('main.tsx', 'import Card from "./Card"; export const view=<><Card src="./fake.png"/><Link href="./fake-link.html"/><Img src="./fake-image.png"/><my-card src="./fake-custom.png"/><img src={"./real.png"} srcSet="./small.png 1x, ./large.png 2x"/><svg><image xlinkHref="./vector.svg"/></svg></>;');
  const html = extractResources('index.html', '<my-card src="./fake-custom.png"></my-card><div src="./fake-div.png"></div><img src="./real.png" srcset="./small.png 1x, ./large.png 2x"><svg><image href="./vector.svg"/></svg>');
  for (const value of [jsx, html]) {
    const targets = value.references.filter(item => item.kind === 'resource').map(item => item.specifier);
    assert.deepEqual(targets.sort(), ['./real.png', './small.png', './large.png', './vector.svg'].sort());
  }
  assert(jsx.references.some(item => item.kind === 'import' && item.specifier === './Card'));
});

test('Angular escaped inline template/style references have file-only navigation; ordinary Unicode ranges stay physical', async () => {
  const page = String.raw`import {Component} from "@angular/core"; import {Card} from "./card";
@Component({imports:[Card],template:"<app-card>\n😀</app-card>",styles:['@import "./theme.css";\n.x{color:red}']}) export class Page {}`;
  await fixture({ ...angular, 'page.ts': page, 'theme.css': '.x{color:red}' }, async (_, analyze) => {
    const graph = await analyze(), source = node(graph, 'page.ts');
    const selector = graph.relations.find(edge => edge.sourceId === source.id && edge.kind === 'framework' && edge.specifier === 'app-card');
    const style = graph.relations.find(edge => edge.sourceId === source.id && edge.kind === 'resource' && edge.specifier === './theme.css');
    assert(selector && style);
    assert(selector.evidence.every(item => !item.range));
    assert(style.evidence.every(item => !item.range), 'Escaped CSS must not be remapped to the decorator metadata range');
    assert(graph.diagnostics.some(item => /escaped inline/.test(item.message)));
  });
  const ordinary = 'import {Component} from "@angular/core"; import {Card} from "./card";\r\n@Component({imports:[Card],template:`😀<app-card></app-card>`,styles:[`@import "./theme.css";`]}) export class Page {}';
  await fixture({ ...angular, 'page.ts': ordinary, 'theme.css': '.x{color:red}' }, async (_, analyze) => {
    const graph = await analyze(), source = node(graph, 'page.ts');
    const selector = graph.relations.find(edge => edge.sourceId === source.id && edge.kind === 'framework' && edge.specifier === 'app-card');
    assert(selector?.evidence.some(item => item.range?.start.line === 1 && item.range.start.character === ordinary.split('\r\n')[1].indexOf('<app-card>')));
  });
  const dynamic = 'import {Component} from "@angular/core"; import {Card} from "./card"; @Component({imports:[Card],template:`<app-card>${label}</app-card>`,styles:[`@import "${sheet}";`,"@import \'./theme.css\';"]}) export class Page {}';
  await fixture({ ...angular, 'page.ts': dynamic, 'theme.css': '.x{color:red}' }, async (_, analyze) => {
    const graph = await analyze(), source = node(graph, 'page.ts');
    assert(graph.diagnostics.some(item => /dynamic inline template/.test(item.message)));
    assert(graph.diagnostics.some(item => /dynamic inline style/.test(item.message)));
    assert(graph.coverage?.find(item => item.fileId === source.id)?.reasonCodes.includes('frameworkLimited'));
    assert(!graph.relations.some(edge => edge.sourceId === source.id && edge.specifier === 'app-card'));
    assert(graph.relations.some(edge => edge.sourceId === source.id && edge.specifier === './theme.css'), 'Known sibling style remains available');
  });
});

test('unknown Nuxt and unsupported Next App profiles restrict framework coverage while preserving explicit imports', async () => {
  for (const nuxt of ['*', '2.17.0', '^3.0.0 || ^4.0.0']) await fixture({ 'package.json': JSON.stringify({ dependencies: { nuxt } }), 'pages/index.vue': '<script setup>import x from "../explicit";</script><template>{{useCart()}}</template>', 'composables/useCart.ts': 'export const useCart=()=>1;', 'explicit.ts': 'export default 1;' }, async (_, analyze) => {
    const graph = await analyze();
    assert(graph.relations.some(edge => edge.kind === 'import' && edge.targetId === node(graph, 'explicit.ts').id));
    assert(!graph.relations.some(edge => edge.kind === 'framework' && edge.certainty === 'confirmed'));
    assert(graph.coverage?.find(item => item.fileId === node(graph, 'pages/index.vue').id)?.reasonCodes.includes('frameworkLimited'), nuxt);
  });
  await fixture({ 'package.json': '{"dependencies":{"next":"12.0.0"}}', 'app/page.tsx': 'export default function Page(){}', 'app/layout.tsx': 'export default function Layout(){}' }, async (_, analyze) => {
    const graph = await analyze();
    assert(!graph.relations.some(edge => edge.kind === 'framework' && edge.certainty === 'confirmed'));
    assert(graph.diagnostics.length);
  });
});

test('unknown Angular, Kit, Astro and Next conventions are partial; supported profiles retain explicit conventions', async () => {
  const examples: Record<string, string>[] = [
    { ...angular, 'package.json': '{"dependencies":{"@angular/core":"*"}}' },
    { 'package.json': '{"dependencies":{"@sveltejs/kit":"workspace:*"}}', 'src/routes/+page.svelte': '<div/>', 'src/routes/+layout.svelte': '<slot/>' },
    { 'package.json': '{"dependencies":{"astro":"*"}}', 'src/pages/index.md': '---\nlayout: ../layouts/Base.astro\n---\n# Page', 'src/layouts/Base.astro': '<slot/>' },
    { 'package.json': '{"dependencies":{"next":"*"}}', 'pages/index.tsx': 'export default function Page(){}', 'pages/_app.tsx': 'export default function App(){}' },
  ];
  for (const entries of examples) await fixture(entries, async (_, analyze) => {
    const graph = await analyze();
    assert(!graph.relations.some(edge => edge.kind === 'framework' && edge.certainty === 'confirmed'));
    assert(graph.coverage?.some(row => row.reasonCodes.includes('frameworkLimited')));
  });
  await fixture({ 'package.json': '{"dependencies":{"astro":"5.0.0"}}', 'src/pages/index.md': '---\nlayout: ../layouts/Base.astro\n---\n# Page', 'src/layouts/Base.astro': '<slot/>' }, async (_, analyze) => {
    const graph = await analyze();
    assert(graph.relations.some(edge => edge.sourceId === node(graph, 'src/pages/index.md').id && edge.targetId === node(graph, 'src/layouts/Base.astro').id && edge.kind === 'framework' && edge.certainty === 'confirmed'));
  });
  await fixture({ 'package.json': '{"dependencies":{"next":"12.0.0"}}', 'pages/index.tsx': 'export default function Page(){}', 'pages/_app.tsx': 'export default function App(){}' }, async (_, analyze) => {
    const graph = await analyze();
    assert(graph.relations.some(edge => edge.sourceId === node(graph, 'pages/index.tsx').id && edge.targetId === node(graph, 'pages/_app.tsx').id && edge.kind === 'framework'));
  });
  await fixture({ 'package.json': '{"dependencies":{"next":"16.0.0"}}', 'next.config.ts': 'export default {...runtime};', 'pages/index.tsx': 'export default function Page(){}', 'pages/_app.tsx': 'export default function App(){}' }, async (_, analyze) => {
    const graph = await analyze();
    assert(graph.coverage?.find(item => item.fileId === node(graph, 'pages/index.tsx').id)?.reasonCodes.includes('frameworkLimited'));
  });
});
