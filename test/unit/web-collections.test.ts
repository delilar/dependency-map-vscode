import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AnalyzerSession } from '../../src/analysis/index';
import { extractJavascript } from '../../src/analysis/javascript';
import { extractResources } from '../../src/analysis/resources';

test('Vite static module collections update on inventory changes and skip test selectors', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-collections-'));
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), '{"dependencies":{"vite":"6.0.0"}}');
    fs.writeFileSync(path.join(directory, 'main.ts'), 'const modules = import.meta.glob(["./*.vue","!./Ignored.vue"]);');
    fs.writeFileSync(path.join(directory, 'Card.vue'), '<template/>'); fs.writeFileSync(path.join(directory, 'Ignored.vue'), '<template/>');
    const roots = [{ id: 'root', name: 'root', path: directory }]; const session = new AnalyzerSession();
    const graph = await session.analyze(roots, { exclude: [] }, []);
    const targets = (value: typeof graph) => value.relations.filter(edge => edge.sourceId.endsWith(':main.ts')).map(edge => value.nodes.find(node => node.id === edge.targetId)?.file?.path).sort();
    assert.deepEqual(targets(graph), ['Card.vue']);
    const next = path.join(directory, 'Next.vue'); fs.writeFileSync(next, '<template/>');
    assert.deepEqual(targets(await session.analyze(roots, { exclude: [] }, [], undefined, [next])), ['Card.vue', 'Next.vue']);
    assert.equal(extractJavascript('vite.config.ts', 'export default {testMatch:["**/*.test.ts"]}').globs, undefined);
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-collections-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('webpack rejects unsafe regex collections and Tramvai APIs reject type-only or lookalike packages', () => {
  assert(extractJavascript('source.ts', 'require.context("./x",true,/(a+)+$/)').references.some(reference => reference.reason));
  assert.equal(extractJavascript('source.ts', 'import type {createApp} from "@tramvai/core"; createApp({modules:[X]});').references.filter(reference => reference.kind === 'framework').length, 0);
  assert.equal(extractJavascript('source.ts', 'import {createApp} from "@tramvai/lookalike"; createApp({modules:[X]});').references.filter(reference => reference.kind === 'framework').length, 0);
});

test('HTML srcset and inline scripts/styles preserve local resources without data URL fragments', () => {
  const value = extractResources('index.html', '<img srcset="data:image/svg+xml,a 1x, ./large.png 2x"><script type="module">import x from "./x.js";</script><style>.x{background:url("./a.svg")}</style>');
  assert.deepEqual(value.references.map(reference => reference.specifier).sort(), ['./a.svg', './large.png', './x.js'].sort());
  assert(extractResources('a.module.css', '.a {composes: root from "./b.module.css"}').references.some(reference => reference.specifier === './b.module.css'));
  assert.equal(extractResources('index.html', '<base href="./nested/"><img src="./x.png">').references[0].specifier, './nested/x.png');
  assert(extractResources('index.html', '<base href="https://example.com/"><img src="./x.png">').references[0].reason);
});
