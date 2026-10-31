import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const count = Number(process.argv[2] ?? 1000);
assert(Number.isInteger(count) && count >= 1000 && count <= 10000, 'Usage: node scripts/ui-benchmark.mjs [1000..10000 nodes]');
const nodes = Array.from({ length: count }, (_, index) => ({ id: `n${index}`, label: `File${index}.tsx`, kind: 'file',
  projectId: `app-${Math.floor(index / 100)}`, projectName: `Application ${Math.floor(index / 100)}`,
  format: '.tsx', file: { rootId: 'benchmark', path: `apps/app-${Math.floor(index / 100)}/src/feature-${index % 25}/File${index}.tsx` } }));
const edge = (source, target, index) => ({ id: `e${index}`, sourceId: `n${source}`, targetId: `n${target}`, kind: 'import', certainty: 'confirmed',
  specifier: `./File${target}`, bindings: [{ imported: `useFeature${target}`, local: `feature${target}`, typeOnly: false }], evidence: [{ rule: 'synthetic import' }] });
const relations = [...Array.from({ length: count }, (_, index) => edge(index, (index + 1) % count, index)),
  ...Array.from({ length: Math.floor(count * 0.9) }, (_, index) => edge(index, (index + 17) % count, count + index))];
const graph = { revision: 1, nodes, relations, unresolved: [], diagnostics: [], stats: { files: count, relations: relations.length, elapsedMs: 0 } };
const state = { type: 'state', graph, view: { mode: 'project', focusId: 'n0', follow: false, depth: 1, hideExternal: true, hideTests: false,
  groupBy: 'none', collapseReexports: false }, status: 'UI synthetic benchmark', annotations: undefined };
await mkdir('.test-dist', { recursive: true });
await build({ stdin: { contents: 'export { projectGraph, groupProjection, searchGraph } from "./src/webview/graph";', resolveDir: process.cwd() },
  outfile: '.test-dist/ui-bench-probe.js', bundle: true, platform: 'browser', target: 'es2022', format: 'iife', globalName: 'DependencyMapProbe' });
const init = `
window.__benchmarkState=${JSON.stringify(state)};
window.__commits={};window.__phase='';window.__started=0;window.__messages=[];window.__longTasks=[];
try{new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(item=>({startTime:item.startTime,duration:item.duration})))).observe({entryTypes:['longtask']});}catch{}
window.__measure=label=>{window.__phase=label;window.__started=performance.now();};
window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:value=>{window.__saved=value;if(window.__phase&&!window.__commits[window.__phase])window.__commits[window.__phase]={commitMs:performance.now()-window.__started};},postMessage:message=>{
window.__messages.push(message.type);
if(message.type==='ready'){window.__measure('initial');window.postMessage(window.__benchmarkState,'*');}
if(message.type==='setView'){window.__benchmarkState.view=message.view;window.postMessage(window.__benchmarkState,'*');}
}});`;
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head>
<body class="vscode-dark" style="--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd;--vscode-sideBar-background:#252526;--vscode-input-background:#333;--vscode-input-foreground:#eee;--vscode-panel-border:#555;--vscode-button-background:#0e639c;--vscode-button-secondaryBackground:#444;--vscode-font-family:Segoe UI;--vscode-font-size:13px"><script>${init}</script><script src="/probe.js"></script><script src="/webview.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
    const file = request.url === '/webview.js' ? 'dist/webview.js' : request.url === '/styles.css' ? 'dist/styles.css'
      : request.url === '/probe.js' ? '.test-dist/ui-bench-probe.js' : undefined;
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/css' }); response.end(await readFile(file));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.__commits.initial);
  const frame = () => page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const metric = window.__commits[window.__phase];
    if (metric) metric.twoFramesMs = performance.now() - window.__started;
  });
  await frame();
  const pure = await page.evaluate(() => {
    const { graph, view } = window.__benchmarkState;
    const times = {};
    for (const [label, operation] of [
      ['projectProjection', () => DependencyMapProbe.projectGraph(graph, view)],
      ['fileProjection', () => DependencyMapProbe.projectGraph(graph, { ...view, mode: 'file', depth: 2 })],
      ['search', () => DependencyMapProbe.searchGraph(graph, 'useFeature997')]
    ]) {
      const samples = [];
      for (let run = 0; run < 10; run++) { const before = performance.now(); operation(); samples.push(performance.now() - before); }
      times[label] = { minMs: Math.min(...samples), meanMs: samples.reduce((sum, item) => sum + item, 0) / samples.length, maxMs: Math.max(...samples) };
    }
    return times;
  });
  const search = page.getByRole('searchbox', { name: 'Поиск по всему индексу' });
  for (const [phase, query] of [['searchInput', 'useFeature997'], ['clearSearch', '']]) {
    await page.evaluate(label => window.__measure(label), phase); await search.fill(query);
    await page.waitForFunction(label => window.__commits[label], phase); await frame();
  }
  await page.getByRole('button', { name: 'File0.tsx', exact: true }).click();
  const selectionMs = await page.evaluate(async () => {
    const before = performance.now();
    document.querySelector('.file-choice').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - before;
  });
  await page.waitForFunction(() => {
    const camera = JSON.stringify(window.__saved.canvas);
    if (window.__settledCamera !== camera) { window.__settledCamera = camera; window.__cameraChangedAt = performance.now(); }
    return performance.now() - window.__cameraChangedAt > 400;
  });
  const progress = await page.evaluate(async () => {
    const first = document.querySelector('.file-choice'); const camera = JSON.stringify(window.__saved.canvas);
    const before = performance.now();
    for (let index = 0; index < 100; index++) window.postMessage({ type: 'status', status: `Progress ${index}`, revision: 1 }, '*');
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { elapsedMs: performance.now() - before, sameListNode: first === document.querySelector('.file-choice'),
      sameCamera: camera === JSON.stringify(window.__saved.canvas), lastStatus: document.querySelector('.status').textContent };
  });
  assert(progress.sameListNode && progress.sameCamera && progress.lastStatus.startsWith('Progress 99'), 'Progress must not reconstruct the graph or camera');
  assert.deepEqual(errors, []);
  const metrics = await page.evaluate(() => ({ commits: window.__commits, longTasks: window.__longTasks,
    browser: navigator.userAgent, canvasCount: document.querySelectorAll('.graph canvas').length }));
  const report = { measuredAt: new Date().toISOString(), environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3), browser: metrics.browser },
    fixture: { nodes: nodes.length, relations: relations.length, source: 'deterministic synthetic frontend graph', viewport: { width: 1600, height: 1000 } },
    pure, commits: metrics.commits, selectionTwoFramesMs: selectionMs, progress, longTasks: metrics.longTasks,
    limitations: ['Headless Edge on this machine; not a VS Code Webview timing guarantee.', 'Two-frame timing includes browser rendering and automation scheduling.', 'Initial project layout uses the existing grid for graphs above 250 nodes.', 'Full graph transmission and analyzer timings are outside this UI-only benchmark.'] };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/ui-benchmark.json', JSON.stringify(report, null, 2));
  await page.getByRole('button', { name: 'Вписать', exact: true }).click(); await page.waitForTimeout(250);
  await page.screenshot({ path: 'artifacts/ui-benchmark.png', fullPage: true });
  console.log(JSON.stringify(report, null, 2));
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
