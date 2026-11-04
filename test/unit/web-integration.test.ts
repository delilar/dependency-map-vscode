import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace, AnalyzerSession } from '../../src/analysis/index';
import { exportTables, resolveExport } from '../../src/analysis/export-resolution';

test('mixed web imports, component exports, config aliases and loader qualifiers share one index', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-web-'));
  const put = (name: string, text: string) => { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  try {
    put('package.json', '{"dependencies":{"vite":"6.0.0","vue":"3.5.0"}}');
    put('vite.config.ts', 'import {defineConfig} from "vite"; import path from "node:path"; export default defineConfig({resolve:{alias:{"@":path.resolve(__dirname,"src")}},publicDir:"static"});');
    put('src/main.ts', 'import {Card} from "./barrel"; import raw from "./Card.vue?raw"; import md from "./guide.mdx"; import icon from "@/icon.svg?url";');
    put('src/barrel.ts', 'export {default as Card} from "./Card.vue";');
    put('src/Card.vue', '<script setup lang="ts">import {run} from "./logic";</script><template><img src="/icon.svg"/></template><style scoped>@import "./theme.css";</style>');
    put('src/logic.ts', 'export const run = 1;');
    put('src/theme.css', '.x {color:red}');
    put('src/icon.svg', '<svg/>'); put('static/icon.svg', '<svg/>');
    put('src/guide.mdx', 'import Card from "./Card.vue";\n\n# Guide\n\n<Card/>');
    const graph = await analyzeWorkspace([{ id: 'web', name: 'web', path: directory }], { exclude: [] }, []);
    const node = (name: string) => graph.nodes.find(item => item.file?.path === name)!;
    assert.equal(graph.coverage?.find(row => row.fileId === node('src/Card.vue').id)?.status, 'parsed');
    assert(graph.relations.some(edge => edge.sourceId === node('src/Card.vue').id && edge.targetId === node('src/logic.ts').id));
    assert(graph.relations.some(edge => edge.sourceId === node('src/Card.vue').id && edge.targetId === node('static/icon.svg').id));
    assert(graph.relations.some(edge => edge.sourceId === node('src/main.ts').id && edge.targetId === node('src/icon.svg').id));
    assert.equal(resolveExport(exportTables(graph), node('src/barrel.ts').id, 'Card', 'value').status, 'resolved');
    const raw = graph.relations.find(edge => edge.specifier === './Card.vue?raw')!;
    assert.equal(raw.kind, 'resource');
    assert(!graph.bindingOccurrences?.some(item => item.relationId === raw.id));
    const session = new AnalyzerSession();
    const roots = [{ id: 'web', name: 'web', path: directory }];
    await session.analyze(roots, { exclude: [] }, []);
    put('vite.config.ts', 'import {defineConfig} from "vite"; import path from "node:path"; export default defineConfig({resolve:{alias:{"@":path.resolve(__dirname,"other")}},publicDir:"static"});');
    put('other/icon.svg', '<svg/>');
    const incremental = await session.analyze(roots, { exclude: [] }, [], undefined, [path.join(directory, 'vite.config.ts'), path.join(directory, 'other/icon.svg')]);
    const full = await analyzeWorkspace(roots, { exclude: [] }, []);
    const rows = (value: typeof graph) => value.relations.map(edge => [edge.sourceId, edge.targetId, edge.kind, edge.specifier]).sort();
    assert.deepEqual(rows(incremental), rows(full));
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-web-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
