import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace, AnalyzerSession, reverseIndex, WorkspaceFiles } from '../../src/analysis/index';
import { extractJavascript } from '../../src/analysis/javascript';
import { extractEnvKeys } from '../../src/analysis/resources';
import type { GraphSnapshot, WorkspaceRoot } from '../../src/shared/model';

function fixture(entries: Record<string, string>): { directory: string; roots: WorkspaceRoot[]; clean(): void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-analysis-'));
  for (const [relative, content] of Object.entries(entries)) {
    const target = path.join(directory, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
  }
  return { directory, roots: [{ id: 'test-root', name: 'fixture', path: directory }], clean: () => {
    const target = path.resolve(directory); const relative = path.relative(path.resolve(os.tmpdir()), target);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(target).startsWith('dependency-map-analysis-'));
    fs.rmSync(target, { recursive: true, force: true });
  } };
}
const options = { exclude: ['.git', 'dist', '.next'] };
const node = (graph: GraphSnapshot, name: string, root = 'test-root') => graph.nodes.find(item => item.file?.rootId === root && item.file.path === name)!;

test('isolates aliases in two roots, preserves bindings, aggregates occurrences and reverse links', async () => {
  const data = fixture({
    'left/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}},"include":["src/**/*"]}',
    'left/src/index.ts': 'import { run as execute, type User } from "@app/logic"; import { run } from "@app/logic"; export { run as start } from "@app/logic";',
    'left/src/logic.ts': 'export const run = () => 1; export interface User { name: string }',
    'right/tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}},"include":["src/**/*"]}',
    'right/src/index.ts': 'import * as logic from "@app/logic";',
    'right/src/logic.ts': 'export const run = () => 2;'
  });
  try {
    const roots = ['left', 'right'].map(id => ({ id, name: id, path: path.join(data.directory, id) }));
    const graph = await analyzeWorkspace(roots, options, []);
    const left = node(graph, 'src/index.ts', 'left'); const right = node(graph, 'src/index.ts', 'right');
    const leftTarget = node(graph, 'src/logic.ts', 'left'); const rightTarget = node(graph, 'src/logic.ts', 'right');
    assert.notEqual(left.id, right.id);
    const relation = graph.relations.find(item => item.sourceId === left.id && item.kind === 'import')!;
    assert.equal(relation.targetId, leftTarget.id); assert.equal(relation.evidence.length, 2);
    assert(relation.bindings.some(item => item.local === 'execute' && item.imported === 'run'));
    assert(relation.bindings.some(item => item.imported === 'User' && item.typeOnly));
    assert.equal(graph.relations.find(item => item.sourceId === right.id)?.targetId, rightTarget.id);
    assert.equal(reverseIndex(graph).get(leftTarget.id)?.length, 2);
    const commonjs = extractJavascript('common.cjs', 'const {run: execute} = require("./logic");');
    assert.deepEqual(commonjs.references[0].bindings, [{ imported: 'run', local: 'execute', typeOnly: false }]);
  } finally { data.clean(); }
});

test('never probes node_modules, including config extends, package metadata and nested inventory', async () => {
  const data = fixture({
    'package.json': '{"dependencies":{"react":"*"}}',
    'tsconfig.json': '{"extends":"./node_modules/private/config.json","include":["src/**/*"]}',
    'src/index.ts': 'import React from "react"; import {x} from "../node_modules/private/index";',
    'node_modules/private/package.json': '{"main":"index.js"}',
    'node_modules/private/config.json': '{}',
    'node_modules/private/index.js': 'throw new Error("must not read")'
  });
  const methods = ['readFileSync', 'readdirSync', 'statSync', 'realpathSync'] as const;
  const original = new Map<string, Function>();
  try {
    for (const method of methods) {
      const fn = fs[method] as Function; original.set(method, fn);
      const wrapped = (...args: unknown[]) => {
        assert(!String(args[0]).replace(/\\/g, '/').split('/').includes('node_modules'), `forbidden fs probe: ${method}`);
        return fn.apply(fs, args);
      };
      if (method === 'realpathSync') (wrapped as any).native = (...args: unknown[]) => {
        assert(!String(args[0]).replace(/\\/g, '/').split('/').includes('node_modules'), 'forbidden native realpath probe');
        return (fn as typeof fs.realpathSync).native.apply(fs, args as [fs.PathLike]);
      };
      (fs as any)[method] = wrapped;
    }
    const graph = await analyzeWorkspace(data.roots, options, []);
    assert(!graph.nodes.some(item => item.file?.path.includes('node_modules')));
    assert(graph.nodes.some(item => item.kind === 'external' && item.packageName === 'react'));
    assert(graph.diagnostics.some(item => item.message.includes('configuration issue')));
    assert(graph.unresolved.some(item => item.expression?.includes('node_modules')));
  } finally {
    for (const [method, fn] of original) (fs as any)[method] = fn;
    data.clean();
  }
});

test('resolves SVG, JSON, SCSS partials, CSS URLs, JSX resources and HTML links', async () => {
  const data = fixture({
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@icons/*":["src/icons/*"]}},"include":["src/**/*"]}',
    'src/main.tsx': 'import icon from "@icons/icon.svg"; import data from "./data.json"; import "./main.scss"; export const View = () => <img src="/photo.jpg"/>;',
    'src/icons/icon.svg': '<svg/>', 'src/data.json': '{"hello":"world"}',
    'src/main.scss': '@use "theme"; .x { background: url("../public/photo.jpg"); }',
    'src/_theme.scss': '$color: red;', 'public/photo.jpg': 'binary-placeholder',
    'index.html': '<html><link href="./src/main.scss" rel="stylesheet"><img src="./public/photo.jpg"></html>'
  });
  try {
    const graph = await analyzeWorkspace(data.roots, options, []);
    const targets = graph.relations.filter(item => item.sourceId === node(graph, 'src/main.tsx').id).map(item => graph.nodes.find(target => target.id === item.targetId)?.file?.path).sort();
    assert.deepEqual(targets, ['public/photo.jpg', 'src/data.json', 'src/icons/icon.svg', 'src/main.scss']);
    assert(graph.relations.some(item => item.sourceId === node(graph, 'src/main.scss').id && item.targetId === node(graph, 'src/_theme.scss').id));
    assert.equal(graph.relations.filter(item => item.sourceId === node(graph, 'index.html').id).length, 2);
  } finally { data.clean(); }
});

test('environment outputs contain only names and overlays take priority without leaking values', async () => {
  const secret = 'SENTINEL_DO_NOT_SERIALIZE_6439';
  const data = fixture({
    '.env': `API_KEY=${secret}\nAPI_URL=https://private.invalid/${secret}`,
    '.env.production': `API_KEY=${secret}`,
    'src/main.ts': 'console.log(process.env.API_KEY, import.meta.env.API_URL, process.env.DEPLOYED_ONLY);'
  });
  try {
    const graph = await analyzeWorkspace(data.roots, options, [{ path: path.join(data.directory, '.env'), version: 1, envKeys: extractEnvKeys(`API_KEY=${secret}\nOTHER=${secret}`) }]);
    assert(!JSON.stringify(graph).includes(secret));
    assert.equal(graph.relations.filter(item => item.kind === 'environment').length, 2);
    assert(graph.relations.every(item => item.kind !== 'environment' || item.certainty === 'inferred'));
    assert(graph.unresolved.some(item => item.expression === 'API_URL'));
    assert(graph.unresolved.some(item => item.expression === 'DEPLOYED_ONLY'));
    assert.deepEqual(extractEnvKeys(`MULTILINE="first\n${secret}=still-a-value\nlast"\nNORMAL=ok`).map(item => item.name), ['MULTILINE', 'NORMAL']);
    const shadowed = extractJavascript('shadow.ts', 'function x(process: any, require: any) { process.env.API_KEY; require("bad"); }');
    assert.equal(shadowed.references.length, 0);
  } finally { data.clean(); }
});

test('document overlays replace imports, restore disk on close, and missing files can resolve on rebuild', async () => {
  const data = fixture({ 'src/main.ts': 'import "./one"; import "./missing";', 'src/one.ts': 'export {}', 'src/two.ts': 'export {}' });
  try {
    const baseline = await analyzeWorkspace(data.roots, options, []);
    const overlay = await analyzeWorkspace(data.roots, options, [{ path: path.join(data.directory, 'src/main.ts'), version: 3, text: 'import "./two";' }]);
    assert.equal(overlay.relations.length, 1);
    assert.equal(overlay.relations[0].targetId, node(overlay, 'src/two.ts').id);
    assert(!reverseIndex(overlay).has(node(overlay, 'src/one.ts').id));
    assert.deepEqual((await analyzeWorkspace(data.roots, options, [])).relations, baseline.relations);
    fs.writeFileSync(path.join(data.directory, 'src/missing.ts'), 'export {}');
    const updated = await analyzeWorkspace(data.roots, options, []);
    assert.equal(updated.unresolved.length, 0); assert.equal(updated.relations.length, 2);
  } finally { data.clean(); }
});

test('uses local package exports and Next conventions without executing project configuration', async () => {
  const data = fixture({
    'package.json': '{"name":"web","dependencies":{"next":"*","@local/ui":"*"}}',
    'next.config.js': 'require("node:fs").writeFileSync("EXECUTED", "bad"); module.exports = {};',
    'packages/ui/package.json': '{"name":"@local/ui","exports":{".":"./src/index.ts"}}',
    'packages/ui/src/index.ts': 'export const Button = 1;',
    'src/pages/_app.tsx': 'export default function App() {}',
    'src/pages/index.tsx': 'import {Button} from "@local/ui";',
    'src/app/layout.tsx': 'export default function Layout() {}',
    'src/app/profile/layout.tsx': 'export default function Layout() {}',
    'src/app/profile/page.tsx': 'export default function Page() {}'
  });
  try {
    const graph = await analyzeWorkspace(data.roots, options, []);
    assert(!fs.existsSync(path.join(data.directory, 'EXECUTED')));
    assert(graph.relations.some(item => item.sourceId === node(graph, 'src/pages/index.tsx').id && item.targetId === node(graph, 'packages/ui/src/index.ts').id && item.kind === 'import'));
    assert(graph.relations.some(item => item.sourceId === node(graph, 'src/pages/index.tsx').id && item.targetId === node(graph, 'src/pages/_app.tsx').id && item.kind === 'framework'));
    assert.equal(graph.relations.filter(item => item.sourceId === node(graph, 'src/app/profile/page.tsx').id && item.kind === 'framework').length, 2);
  } finally { data.clean(); }
});

test('Tramvai links explicit declarations and declared child names, preserving uncertainty', async () => {
  const data = fixture({
    'package.json': '{"dependencies":{"@tramvai/core":"*","@tramvai/child-app-core":"*","@tramvai/module-child-app":"*","@tramvai/react":"*"}}',
    'module.ts': 'export const CustomModule = {};',
    'child.tsx': 'import {createChildApp as child} from "@tramvai/child-app-core"; import {CustomModule} from "./module"; export default child({name:"header",modules:[CustomModule]});',
    'root.tsx': 'import {createApp,provide} from "@tramvai/core"; import {CHILD_APP_RESOLUTION_CONFIGS_TOKEN as CHILDREN} from "@tramvai/module-child-app"; createApp({name:"root",providers:[provide({provide:CHILDREN,useValue:[{name:"header",byTag:{latest:{version:"1"}}}]})]});',
    'tokens.ts': 'export const API = Symbol("API");',
    'provider.ts': 'import {provide} from "@tramvai/core"; import {API} from "./tokens"; export const provider = provide({provide:API,useValue:{}});',
    'consumer.tsx': 'import {useDi} from "@tramvai/react"; import {API as TOKEN} from "./tokens"; export function View() { return useDi(TOKEN); }'
  });
  try {
    const graph = await analyzeWorkspace(data.roots, options, []);
    assert(graph.relations.some(item => item.sourceId === node(graph, 'child.tsx').id && item.targetId === node(graph, 'module.ts').id && item.kind === 'framework'));
    const childEdge = graph.relations.find(item => item.sourceId === node(graph, 'root.tsx').id && item.targetId === node(graph, 'child.tsx').id && item.kind === 'framework');
    assert.equal(childEdge?.certainty, 'inferred');
    const providerEdge = graph.relations.find(item => item.sourceId === node(graph, 'consumer.tsx').id && item.targetId === node(graph, 'provider.ts').id && item.kind === 'framework');
    assert.equal(providerEdge?.certainty, 'inferred');
    assert(providerEdge?.evidence.some(item => item.rule.includes('not proven')));
    const computed = extractJavascript('root.ts', 'import {createApp} from "@tramvai/core"; createApp(options);');
    assert(computed.diagnostics.some(item => item.includes('not an inline object')));
  } finally { data.clean(); }
});

test('symlinks cannot escape allowed roots', async () => {
  const outside = fixture({ 'hidden.ts': 'export const secret = 1;' });
  const data = fixture({ 'main.ts': 'import "./linked/hidden";' });
  try {
    fs.symlinkSync(outside.directory, path.join(data.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const files = new WorkspaceFiles(data.roots, [], []); files.scan();
    assert(!files.allowed(path.join(data.directory, 'linked/hidden.ts')));
    const graph = await analyzeWorkspace(data.roots, options, []);
    assert.equal(graph.relations.length, 0); assert.equal(graph.unresolved.length, 1);
  } finally { data.clean(); outside.clean(); }
});

test('declaration navigation follows named/default aliases and reexports without guessing through ambiguity or cycles', async () => {
  const data = fixture({
    'entry.ts': 'import {Button as LocalButton} from "./barrel"; import {clash} from "./ambiguous"; import {missing} from "./cycle-a"; import {clash as hidden} from "./star-a"; import {clash as hiddenAgain} from "./star-b";',
    'barrel.ts': 'export {default as Button} from "./button";',
    'button.tsx': 'export default function Button() { return null; }',
    'ambiguous.ts': 'export * from "./left"; export * from "./right";',
    'left.ts': 'export const clash = 1;', 'right.ts': 'export const clash = 2;',
    'cycle-a.ts': 'export * from "./cycle-b";', 'cycle-b.ts': 'export * from "./cycle-a";',
    'star-a.ts': 'export * from "./star-b"; export * from "./left";',
    'star-b.ts': 'export * from "./star-a"; export * from "./right";'
  });
  try {
    const graph = await analyzeWorkspace(data.roots, options, []);
    const sourceId = node(graph, 'entry.ts').id;
    const imported = graph.declarations?.filter(item => graph.relations.find(edge => edge.id === item.relationId)?.sourceId === sourceId) ?? [];
    assert.equal(imported.length, 1);
    assert.equal(imported[0].imported, 'Button');
    assert.equal(imported[0].file.path, 'button.tsx');
    assert.equal(imported[0].range.start.character, 'export default function '.length);
    const repeated = await analyzeWorkspace(data.roots, options, []);
    assert.deepEqual(repeated.declarations, graph.declarations);
  } finally { data.clean(); }
});

test('bare and node-prefixed built-ins are external without requiring package dependencies', async () => {
  const data = fixture({ 'main.ts': 'import fs from "fs"; import {readFile} from "fs/promises"; import path from "node:path"; import "node:not_a_real_builtin";' });
  try {
    const graph = await analyzeWorkspace(data.roots, options, []);
    assert.deepEqual(graph.nodes.filter(item => item.kind === 'external').map(item => item.packageName).sort(), ['node:fs', 'node:fs/promises', 'node:path']);
    assert.equal(graph.relations.length, 3);
    assert.equal(graph.unresolved.length, 1);
    assert.equal(graph.unresolved[0].reason, 'Unknown Node built-in module name');
  } finally { data.clean(); }
});

test('reports sanitized syntax diagnostics instead of silently treating partial AST as complete', async () => {
  const sourceMarker = 'PRIVATE_SOURCE_FRAGMENT_9541';
  const data = fixture({ 'broken.ts': `const ${sourceMarker} = ;\nexport {`, '.env': `PASSWORD="${sourceMarker}\n${sourceMarker}=still-a-value\nend"` });
  try {
    const graph = await analyzeWorkspace(data.roots, options, []);
    const errors = graph.diagnostics.filter(item => item.fileId === node(graph, 'broken.ts').id);
    assert(errors.length > 0);
    assert(errors.every(item => /parse error TS\d+ at \d+:\d+; analysis may be incomplete/.test(item.message)));
    assert(!JSON.stringify(graph).includes(sourceMarker));
    assert(!JSON.stringify(graph).includes('still-a-value'));
  } finally { data.clean(); }
});

test('does not identify shadowed imported Tramvai APIs or tokens as framework declarations', () => {
  const result = extractJavascript('shadow.ts', `
    import {createApp as run, provide} from '@tramvai/core';
    import {useDi} from '@tramvai/react';
    import {ModuleClass, TOKEN} from './module';
    function local(run: any, useDi: any, provide: any) {
      run({modules:[ModuleClass]}); useDi(TOKEN); provide({provide:TOKEN,useValue:1});
    }
    function scoped(TOKEN: any, ModuleClass: any) {
      useDi(TOKEN); run({modules:[ModuleClass]});
    }
  `);
  assert.equal(result.references.filter(item => item.kind === 'framework').length, 0);
  assert.equal(result.consumers.length, 0);
  assert.equal(result.providers.length, 0);
});

function comparable(graph: GraphSnapshot): unknown {
  const sorted = <T>(values: T[]) => [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    nodes: sorted(graph.nodes),
    relations: sorted(graph.relations.map(relation => ({ ...relation, bindings: sorted(relation.bindings), evidence: sorted(relation.evidence) }))),
    unresolved: sorted(graph.unresolved), diagnostics: sorted(graph.diagnostics), declarations: sorted(graph.declarations ?? [])
  };
}

test('incremental updates reuse untouched source resolutions and context without reading or rescanning them', async () => {
  const data = fixture({
    'package.json': '{"name":"test-app"}',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}},"include":["src/**/*"]}',
    'src/entry.ts': 'import {run} from "@app/barrel";', 'src/barrel.ts': 'export {run} from "./changed";',
    'src/changed.ts': 'export function run() {return 1}',
    'src/unrelated.ts': 'import {untouched} from "./untouched"; export const value = untouched;',
    'src/untouched.ts': 'export const untouched = 1;'
  });
  try {
    const session = new AnalyzerSession(); await session.analyze(data.roots, options, []);
    const changedPath = path.join(data.directory, 'src/changed.ts');
    fs.writeFileSync(changedPath, '\nexport function run() {return 2}');
    const readFile = fs.readFileSync; const readdir = fs.readdirSync;
    const neverRead = ['src/unrelated.ts', 'src/untouched.ts', 'package.json', 'tsconfig.json'].map(file => path.resolve(data.directory, file).toLowerCase());
    let incremental: GraphSnapshot;
    const messages: string[] = [];
    try {
      (fs as any).readFileSync = (...args: unknown[]) => {
        assert(!neverRead.includes(path.resolve(String(args[0])).toLowerCase()), `untouched source/context was read: ${args[0]}`);
        return (readFile as Function).apply(fs, args);
      };
      (fs as any).readdirSync = (...args: unknown[]) => { throw new Error(`unexpected inventory rescan: ${args[0]}`); };
      incremental = await session.analyze(data.roots, options, [], message => messages.push(message), [changedPath]);
    } finally { fs.readFileSync = readFile; fs.readdirSync = readdir; }
    assert(messages.at(-1)?.includes('Incremental analysis: 3 affected source files; reused 4 contributions'));
    assert.deepEqual(comparable(incremental!), comparable(await analyzeWorkspace(data.roots, options, [])));
    const target = incremental!.declarations?.find(item => item.imported === 'run');
    assert.equal(target?.range.start.line, 1);
  } finally { data.clean(); }
});

test('incremental creation, deletion and rename repair resolved targets, unresolved candidates and reverse links', async () => {
  const data = fixture({ 'entry.ts': 'import "./feature"; import "./missing";', 'feature/index.ts': 'export const old = 1;', 'independent.ts': 'export {}' });
  try {
    const session = new AnalyzerSession(); await session.analyze(data.roots, options, []);
    const verify = async (changed: string[]) => {
      const incremental = await session.analyze(data.roots, options, [], undefined, changed);
      assert.deepEqual(comparable(incremental), comparable(await analyzeWorkspace(data.roots, options, [])));
      return incremental;
    };
    const feature = path.join(data.directory, 'feature.ts'); fs.writeFileSync(feature, 'export const fresh = 1;');
    let graph = await verify([feature]);
    assert(graph.relations.some(item => item.targetId === node(graph, 'feature.ts').id));
    assert(!reverseIndex(graph).has(node(graph, 'feature/index.ts').id));
    const missing = path.join(data.directory, 'missing.ts'); fs.writeFileSync(missing, 'export {}');
    graph = await verify([missing]); assert.equal(graph.unresolved.length, 0);
    fs.unlinkSync(feature); graph = await verify([feature]);
    assert(graph.relations.some(item => item.targetId === node(graph, 'feature/index.ts').id));
    const oldName = path.join(data.directory, 'feature/index.ts'); const newName = path.join(data.directory, 'feature/renamed.ts');
    fs.renameSync(oldName, newName); graph = await verify([oldName, newName]);
    assert(graph.unresolved.some(item => item.expression === './feature'));
  } finally { data.clean(); }
});

test('incremental config edits and inherited aliases rebuild context while export changes refresh declaration chains', async () => {
  const data = fixture({
    'base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@alias":["left.ts"]}}}',
    'tsconfig.json': '{"extends":"./base.json","include":["**/*.ts"]}',
    'entry.ts': 'import {run} from "./barrel"; import {value} from "@alias";',
    'barrel.ts': 'export {run} from "./source";', 'source.ts': 'export const run = 1;',
    'left.ts': 'export const value = 1;', 'right.ts': 'export const value = 2;', 'other.ts': 'export const run = 3;'
  });
  try {
    const session = new AnalyzerSession(); await session.analyze(data.roots, options, []);
    const verify = async (changed: string[]) => {
      const messages: string[] = [];
      const graph = await session.analyze(data.roots, options, [], message => messages.push(message), changed);
      assert.deepEqual(comparable(graph), comparable(await analyzeWorkspace(data.roots, options, [])));
      return { graph, messages };
    };
    const base = path.join(data.directory, 'base.json'); fs.writeFileSync(base, '{"compilerOptions":{"baseUrl":".","paths":{"@alias":["right.ts"]}}}');
    let result = await verify([base]);
    assert(result.messages.at(-1)?.startsWith('Full analysis'));
    assert(result.graph.relations.some(item => item.specifier === '@alias' && item.targetId === node(result.graph, 'right.ts').id));
    const source = path.join(data.directory, 'source.ts'); fs.writeFileSync(source, 'export const renamed = 1;');
    result = await verify([source]);
    assert(!result.graph.declarations?.some(item => item.imported === 'run' && item.file.path === 'source.ts'));
    const barrel = path.join(data.directory, 'barrel.ts'); fs.writeFileSync(barrel, 'export {run} from "./other";');
    result = await verify([barrel]);
    assert(result.graph.declarations?.some(item => item.imported === 'run' && item.file.path === 'other.ts'));
  } finally { data.clean(); }
});

test('incremental overlay closure and env-key changes stay equivalent to fresh analysis without secrets', async () => {
  const data = fixture({ 'entry.ts': 'import "./left"; console.log(process.env.API_KEY);', 'left.ts': 'export {}', 'right.ts': 'export {}', '.env': 'OTHER=private' });
  try {
    const session = new AnalyzerSession(); await session.analyze(data.roots, options, []);
    const overlay = { path: path.join(data.directory, 'entry.ts'), version: 2, text: 'import "./right"; console.log(process.env.API_KEY);' };
    let graph = await session.analyze(data.roots, options, [overlay], undefined, []);
    assert.deepEqual(comparable(graph), comparable(await analyzeWorkspace(data.roots, options, [overlay])));
    graph = await session.analyze(data.roots, options, [], undefined, []);
    assert.deepEqual(comparable(graph), comparable(await analyzeWorkspace(data.roots, options, [])));
    const env = path.join(data.directory, '.env'); const secret = 'NEVER_INCLUDE_INCREMENTAL_SECRET';
    fs.writeFileSync(env, `API_KEY=${secret}`);
    graph = await session.analyze(data.roots, options, [], undefined, [env]);
    assert.deepEqual(comparable(graph), comparable(await analyzeWorkspace(data.roots, options, [])));
    assert.equal(graph.relations.filter(item => item.kind === 'environment').length, 1);
    assert(!JSON.stringify(graph).includes(secret));
  } finally { data.clean(); }
});

test('incremental inventory refresh updates empty-config membership and directory context changes fall back safely', async () => {
  const data = fixture({ 'tsconfig.json': '{"include":["src/**/*.ts"]}', 'src/placeholder.txt': 'not source code' });
  try {
    const session = new AnalyzerSession(); await session.analyze(data.roots, options, []);
    const created = path.join(data.directory, 'src/new.ts'); fs.writeFileSync(created, 'export const value = 1;');
    let graph = await session.analyze(data.roots, options, [], undefined, [created]);
    assert.deepEqual(comparable(graph), comparable(await analyzeWorkspace(data.roots, options, [])));
    assert(!graph.diagnostics.some(item => item.message.includes('TS18003')));
    fs.writeFileSync(path.join(data.directory, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}},"include":["src/**/*.ts"]}');
    fs.writeFileSync(created, 'import {value} from "@app/target";'); fs.writeFileSync(path.join(data.directory, 'src/target.ts'), 'export const value = 2;');
    const messages: string[] = [];
    graph = await session.analyze(data.roots, options, [], message => messages.push(message), [data.directory]);
    assert(messages.at(-1)?.startsWith('Full analysis'));
    assert.deepEqual(comparable(graph), comparable(await analyzeWorkspace(data.roots, options, [])));
  } finally { data.clean(); }
});

test('resource resolution stays inside style language domains and never substitutes asset URLs or SVGs with code/shims', async () => {
  const data = fixture({
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@icons/*":["icons/*"]}},"include":["**/*.ts"]}',
    'main.ts': 'import image from "@icons/logo.svg"; export const imageUrl = new URL("./asset", import.meta.url);',
    'icons/logo.svg': '<svg/>', 'icons/logo.d.svg.ts': 'declare const url: string; export default url;',
    'styles.scss': '@use "tokens"; @use "palette"; .x{ background:url("asset"); mask-image:url("missing"); }',
    'tokens.ts': 'export const tokens = {};',
    '_palette.sass': '$color: red', 'palette.less': '@color: red;', 'palette.styl': 'color = red',
    'asset.ts': 'export default 1;', 'asset.scss': '.asset{}', 'asset': 'exact-resource',
    'missing.ts': 'export default 2;',
    'styles.less': '@import "theme"; .x { background: url("missing"); }',
    'theme.less': '@color: red;', 'theme.ts': 'export const color = 1;',
    'styles.styl': '@import "theme"\n.x\n  color red\n', 'theme.styl': 'color = red'
  });
  try {
    const graph = await analyzeWorkspace(data.roots, options, []);
    assert(graph.relations.some(item => item.sourceId === node(graph, 'main.ts').id && item.targetId === node(graph, 'icons/logo.svg').id));
    assert(!graph.relations.some(item => item.targetId === node(graph, 'icons/logo.d.svg.ts').id));
    assert(graph.relations.some(item => item.sourceId === node(graph, 'styles.scss').id && item.targetId === node(graph, '_palette.sass').id));
    assert(graph.relations.some(item => item.sourceId === node(graph, 'styles.less').id && item.targetId === node(graph, 'theme.less').id));
    assert(graph.relations.some(item => item.sourceId === node(graph, 'styles.styl').id && item.targetId === node(graph, 'theme.styl').id));
    assert(!graph.relations.some(item => ['tokens.ts', 'theme.ts', 'missing.ts', 'asset.ts', 'asset.scss'].some(file => item.targetId === node(graph, file).id)));
    assert(graph.relations.some(item => item.sourceId === node(graph, 'styles.scss').id && item.targetId === node(graph, 'asset').id));
    assert(graph.unresolved.some(item => item.sourceId === node(graph, 'styles.scss').id && item.expression === 'tokens'));
    assert(graph.unresolved.some(item => item.sourceId === node(graph, 'styles.scss').id && item.expression === 'missing'));
  } finally { data.clean(); }
});

test('workspace analysis exposes explainable roles in each project context and updates them after a move', async () => {
  const data = fixture({
    'package.json': '{"private":true,"workspaces":["apps/*"]}',
    'apps/components/package.json': '{"name":"@fixture/components"}',
    'apps/components/src/Feature.tsx': 'export default function Feature() {}',
    'apps/components/src/main.tsx': 'export {};',
    'apps/web/package.json': '{"name":"@fixture/web","dependencies":{"next":"*"}}',
    'apps/web/src/app/(auth)/page.tsx': 'export default function Page() {}',
    'apps/web/src/app/(auth)/layout.tsx': 'export default function Layout() {}',
    'apps/web/src/app/api/user/route.ts': 'export const GET = () => null;',
    'apps/web/src/components/Button.tsx': 'export const Button = () => null;',
    'apps/web/src/__mocks__/sample.json': '{}',
    'apps/web/src/components/Button.module.scss': '.button {}'
  });
  try {
    const session = new AnalyzerSession();
    const graph = await session.analyze(data.roots, options, []);
    assert.equal(node(graph, 'apps/components/src/Feature.tsx').role, 'source');
    assert.equal(node(graph, 'apps/components/src/main.tsx').role, 'entry');
    assert.equal(node(graph, 'apps/web/src/app/(auth)/page.tsx').role, 'page');
    assert.equal(node(graph, 'apps/web/src/app/(auth)/layout.tsx').role, 'layout');
    assert.equal(node(graph, 'apps/web/src/app/api/user/route.ts').role, 'route');
    assert.equal(node(graph, 'apps/web/src/__mocks__/sample.json').role, 'mock');
    assert.equal(node(graph, 'apps/web/src/components/Button.module.scss').role, 'style');
    assert(node(graph, 'apps/web/src/components/Button.tsx').roleReason?.includes('каталог components'));
    const before = path.join(data.directory, 'apps/web/src/components/Button.tsx');
    const after = path.join(data.directory, 'apps/web/src/hooks/useButton.tsx');
    fs.mkdirSync(path.dirname(after)); fs.renameSync(before, after);
    const updated = await session.analyze(data.roots, options, [], undefined, [before, after]);
    assert.equal(node(updated, 'apps/web/src/hooks/useButton.tsx').role, 'hook');
    assert.deepEqual(comparable(updated), comparable(await analyzeWorkspace(data.roots, options, [])));
  } finally { data.clean(); }
});

test('incremental directory events preserve physical directory casing and file identities', async () => {
  const data = fixture({ 'entry.ts': 'export {};' });
  try {
    const session = new AnalyzerSession(); await session.analyze(data.roots, options, []);
    const before = path.join(data.directory, 'src', 'Components');
    fs.mkdirSync(before, { recursive: true }); fs.writeFileSync(path.join(before, 'Button.tsx'), 'export const Button = () => null;');
    const messages: string[] = [];
    let updated = await session.analyze(data.roots, options, [], message => messages.push(message), [before]);
    assert(messages.at(-1)?.startsWith('Incremental analysis'));
    assert.equal(node(updated, 'src/Components/Button.tsx').role, 'component');
    assert.deepEqual(comparable(updated), comparable(await analyzeWorkspace(data.roots, options, [])));
    const after = path.join(data.directory, 'src', 'Hooks'); fs.renameSync(before, after);
    updated = await session.analyze(data.roots, options, [], undefined, [before, after]);
    assert.equal(node(updated, 'src/Hooks/Button.tsx').role, 'hook');
    assert.deepEqual(comparable(updated), comparable(await analyzeWorkspace(data.roots, options, [])));
  } finally { data.clean(); }
});
