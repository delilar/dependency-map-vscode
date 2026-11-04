import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace } from '../../src/analysis/index';
import { scopedGraph } from '../../src/shared/scope';
import type { GraphSnapshot } from '../../src/shared/model';

async function fixture(entries: Record<string, string>, run: (graph: GraphSnapshot) => void): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-angular-proof-'));
  try {
    for (const [relative, text] of Object.entries(entries)) {
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    await run(await analyzeWorkspace([{ id: 'angular', name: 'angular', path: directory }], { exclude: [] }, []));
  } finally {
    const target = path.resolve(directory), relative = path.relative(path.resolve(os.tmpdir()), target);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(target).startsWith('dependency-map-angular-proof-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
const node = (graph: GraphSnapshot, relative: string) => {
  const value = graph.nodes.find(candidate => candidate.file?.path === relative);
  assert(value, `Missing fixture node ${relative}`); return value;
};
const selectorEdge = (graph: GraphSnapshot) => graph.relations.find(edge => edge.sourceId === node(graph, 'feature/page.html').id && edge.targetId === node(graph, 'feature/card.ts').id && edge.kind === 'framework');
const scope = { version: 1 as const, folders: [{ rootId: 'angular', path: 'feature' }], excludeRoles: [] };

test('standalone imports resolve aliased default components through a barrel with physical declaration ranges', async () => {
  await fixture({
    'package.json': '{"dependencies":{"@angular/core":"21.0.0"}}',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@ui/*":["outside/*"]}}}',
    'feature/card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<span/>"}) export default class Card {}',
    'outside/Card.ts': 'export {default} from "../feature/card";',
    'feature/page.ts': 'import * as ng from "@angular/core"; import DisplayCard from "@ui/Card"; @ng.Component({standalone:true,imports:[DisplayCard],templateUrl:"./page.html"}) export class Page {}',
    'feature/page.html': '<app-card/>',
  }, graph => {
    const edge = selectorEdge(graph);
    assert(edge, 'The common resolver must map default export ranges to the canonical Card class');
    assert.equal(edge.certainty, 'confirmed');
    assert(edge.provenanceIds?.includes(node(graph, 'outside/Card.ts').id));
    assert(!scopedGraph(graph, scope).relations.some(candidate => candidate.id === edge.id), 'Q must exclude the outside alias/barrel proof');
  });
});

test('NgModule membership keeps canonical identity while namespace and named forwarding carry every proof file', async () => {
  await fixture({
    'package.json': '{"dependencies":{"@angular/core":"18.0.1"}}',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@widgets":["outside/index.ts"]}}}',
    'feature/card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",standalone:true,template:"<div/>"}) export class Card {}',
    'outside/forward.ts': 'export {Card as ForwardCard} from "../feature/card";',
    'outside/index.ts': 'export {ForwardCard as Widget} from "./forward";',
    'feature/page.ts': 'import {Component} from "@angular/core"; @Component({standalone:false,templateUrl:"./page.html"}) export class Page {}',
    'feature/module.ts': 'import * as ng from "@angular/core"; import * as ui from "@widgets"; import {Page} from "./page"; @ng.NgModule({declarations:[Page],imports:[ui.Widget],exports:[ui.Widget]}) export class FeatureModule {}',
    'feature/page.html': '<app-card/>',
  }, graph => {
    const edge = selectorEdge(graph);
    assert(edge, 'The Page class resolved for NgModule membership must be the same canonical object');
    for (const relative of ['feature/page.ts', 'feature/module.ts', 'outside/forward.ts', 'outside/index.ts']) assert(edge.provenanceIds?.includes(node(graph, relative).id), relative);
    assert(!scopedGraph(graph, scope).relations.some(candidate => candidate.id === edge.id));
  });
});

test('unresolved registration names remain partial instead of matching a global selector', async () => {
  await fixture({
    'package.json': '{"dependencies":{"@angular/core":"21.0.0"}}',
    'feature/card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<div/>"}) export class Card {}',
    'feature/page.ts': 'import {Component} from "@angular/core"; import {Missing} from "./missing"; @Component({imports:[Missing],templateUrl:"./page.html"}) export class Page {}',
    'feature/page.html': '<app-card/>',
  }, graph => {
    assert.equal(selectorEdge(graph), undefined);
    assert(graph.diagnostics.some(diagnostic => diagnostic.fileId === node(graph, 'feature/page.ts').id && diagnostic.capability === 'framework' && /unresolved/.test(diagnostic.message)));
  });
});

test('branching NgModule export graphs stop at the total expansion budget', async () => {
  const entries: Record<string, string> = {
    'package.json': '{"dependencies":{"@angular/core":"21.0.0"}}',
    'feature/card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<div/>"}) export class Card {}',
    'feature/page.ts': 'import {Component} from "@angular/core"; import {A14} from "../modules/A14"; @Component({imports:[A14],templateUrl:"./page.html"}) export class Page {}',
    'feature/page.html': '<app-card/>',
  };
  for (let level = 0; level <= 14; level++) for (const branch of ['A', 'B']) {
    const imports = level === 0 ? 'import {Card} from "../feature/card";' : `import {A${level - 1}} from "./A${level - 1}"; import {B${level - 1}} from "./B${level - 1}";`;
    const names = level === 0 ? 'Card' : `A${level - 1},B${level - 1}`;
    entries[`modules/${branch}${level}.ts`] = `import {NgModule} from "@angular/core"; ${imports} @NgModule({imports:[${names}],exports:[${names}]}) export class ${branch}${level} {}`;
  }
  await fixture(entries, graph => {
    assert(graph.diagnostics.some(diagnostic => diagnostic.fileId === node(graph, 'feature/page.ts').id && /expansion limit/.test(diagnostic.message)));
    const edge = selectorEdge(graph);
    if (edge) assert.equal(edge.certainty, 'inferred', 'A limited scope cannot assert a unique complete registration proof');
    assert.equal(graph.stats.files, Object.keys(entries).length);
  });
});

test('NgModule scope traversal stops beyond one hundred export hops', async () => {
  const entries: Record<string, string> = {
    'package.json': '{"dependencies":{"@angular/core":"21.0.0"}}',
    'feature/card.ts': 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<div/>"}) export class Card {}',
    'feature/page.ts': 'import {Component} from "@angular/core"; import {M102} from "../modules/M102"; @Component({imports:[M102],templateUrl:"./page.html"}) export class Page {}',
    'feature/page.html': '<app-card/>',
  };
  for (let level = 0; level <= 102; level++) {
    const imported = level === 0 ? 'import {Card} from "../feature/card";' : `import {M${level - 1}} from "./M${level - 1}";`;
    const name = level === 0 ? 'Card' : `M${level - 1}`;
    entries[`modules/M${level}.ts`] = `import {NgModule} from "@angular/core"; ${imported} @NgModule({imports:[${name}],exports:[${name}]}) export class M${level} {}`;
  }
  await fixture(entries, graph => {
    assert(graph.diagnostics.some(diagnostic => diagnostic.fileId === node(graph, 'feature/page.ts').id && /expansion limit/.test(diagnostic.message)));
    assert.equal(selectorEdge(graph), undefined, 'A depth-limited path cannot prove a selector through unvisited registrations');
  });
});
