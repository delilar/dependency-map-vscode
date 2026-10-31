import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (!args.length || (args.includes('--synthetic') && args.length !== 1)) {
  throw new Error('Usage: node scripts/benchmark.mjs <workspace-root> [other-root ...] OR --synthetic');
}
await mkdir('.test-dist', { recursive: true });
await build({ entryPoints: ['src/analysis/index.ts'], outfile: '.test-dist/benchmark-analyzer.cjs', bundle: true, platform: 'node', target: 'node18', format: 'cjs', keepNames: true });
const { AnalyzerSession } = createRequire(import.meta.url)('../.test-dist/benchmark-analyzer.cjs');
let temporary;
async function put(relative, text) {
  const file = path.join(temporary, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text);
}
try {
  if (args[0] === '--synthetic') {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'dependency-map-benchmark-'));
    await put('package.json', JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
    await put('packages/shared/package.json', JSON.stringify({ name: '@fixture/shared', exports: './src/index.ts' }));
    await put('packages/shared/src/index.ts', Array.from({ length: 100 }, (_, index) => `export { shared${index} } from './value${index}';`).join('\n'));
    for (let index = 0; index < 100; index++) await put(`packages/shared/src/value${index}.ts`, `export const shared${index} = ${index};`);
    for (const application of ['shell', 'catalog', 'account']) {
      await put(`apps/${application}/package.json`, JSON.stringify({ name: `@fixture/${application}`, exports: './src/index.ts', dependencies: { '@fixture/shared': '*', '@fixture/catalog': '*', '@fixture/account': '*' } }));
      await put(`apps/${application}/tsconfig.json`, JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } }, include: ['src/**/*'] }));
      await put(`apps/${application}/src/index.ts`, `${application === 'shell' ? 'import "@fixture/catalog"; import "@fixture/account";\n' : ''}${Array.from({ length: 300 }, (_, index) => `export { value${index} } from '@app/value${index}';`).join('\n')}`);
      for (let index = 0; index < 300; index++) await put(`apps/${application}/src/value${index}.ts`, `import {shared${index % 100}} from '@fixture/shared'; export const value${index} = shared${index % 100};`);
    }
  }
  const paths = temporary ? [temporary] : args.map(value => path.resolve(value));
  const roots = paths.map((directory, index) => ({ id: `benchmark-${index}`, name: path.basename(directory), path: directory }));
  const options = { exclude: ['.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', '.cache', '.turbo'] };
  const runs = [];
  const session = new AnalyzerSession();
  let baseline;
  for (const name of ['cold', 'warm']) {
    const messages = [];
    const graph = await session.analyze(roots, options, [], message => messages.push(message));
    baseline = graph;
    const reasons = {};
    for (const unresolved of graph.unresolved) reasons[unresolved.reason] = (reasons[unresolved.reason] ?? 0) + 1;
    runs.push({ name, ...graph.stats, nodes: graph.nodes.length, declarations: graph.declarations?.length ?? 0, unresolved: graph.unresolved.length, unresolvedReasons: reasons, diagnostics: graph.diagnostics.length, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024), parsing: messages.at(-1) });
  }
  const incoming = new Map();
  for (const edge of baseline.relations) incoming.set(edge.targetId, (incoming.get(edge.targetId) ?? 0) + 1);
  const code = baseline.nodes.filter(node => node.file && node.format === '.tsx');
  if (!code.length) code.push(...baseline.nodes.filter(node => node.file && ['.ts', '.js', '.jsx'].includes(node.format)));
  code.sort((left, right) => (incoming.get(left.id) ?? 0) - (incoming.get(right.id) ?? 0) || left.file.path.localeCompare(right.file.path));
  const central = baseline.nodes.filter(node => node.file && ['.tsx', '.ts', '.js', '.jsx'].includes(node.format)).sort((left, right) => (incoming.get(right.id) ?? 0) - (incoming.get(left.id) ?? 0))[0];
  for (const [name, selected, scenario] of code.length ? [
    ['incremental-overlay', code[0], 'Append newline to a file with few incoming relations; source project is not modified.'],
    ['incremental-central', central, 'Append newline to the code file with most direct incoming relations; source project is not modified.']
  ] : []) {
    const absolute = path.resolve(roots.find(root => root.id === selected.file.rootId).path, selected.file.path);
    const text = await readFile(absolute, 'utf8');
    const messages = [];
    const graph = await session.analyze(roots, options, [{ path: absolute, version: 1, text: `${text}\n` }], message => messages.push(message), [absolute]);
    if (graph.nodes.length !== baseline.nodes.length || graph.relations.length !== baseline.relations.length || graph.unresolved.length !== baseline.unresolved.length || (graph.declarations?.length ?? 0) !== (baseline.declarations?.length ?? 0)) throw new Error('Appending a newline unexpectedly changed graph counts');
    runs.push({ name, file: selected.file.path, incomingRelations: incoming.get(selected.id) ?? 0, scenario, ...graph.stats, nodes: graph.nodes.length, declarations: graph.declarations?.length ?? 0, unresolved: graph.unresolved.length, diagnostics: graph.diagnostics.length, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024), parsing: messages.at(-1) });
  }
  const report = {
    timestamp: new Date().toISOString(), mode: temporary ? 'synthetic:3-apps-and-shared-package' : 'explicit-workspace-roots',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model },
    roots: roots.map(root => root.name), runs,
    limitations: ['Cold/warm runs rebuild inventory and resolution; incremental runs reuse unaffected file contributions and resolver context.', 'The central scenario maximizes direct incoming relations; it is not a proof of the worst-case transitive dependency closure.', 'This measures analysis, not Webview transport or Cytoscape layout.', 'RSS includes bundled TypeScript runtime.']
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/benchmark.json', `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (temporary) {
    const target = path.resolve(temporary);
    const relative = path.relative(path.resolve(os.tmpdir()), target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !path.basename(target).startsWith('dependency-map-benchmark-')) throw new Error('Refusing to remove an unexpected benchmark directory');
    await rm(target, { recursive: true, force: true });
  }
}
