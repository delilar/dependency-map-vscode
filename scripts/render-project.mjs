import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { parserPlugin, buildParserAssets } from './parser-build.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/render-project.mjs <workspace-root>');
await mkdir('.test-dist', { recursive: true });
await buildParserAssets('.test-dist');
await build({ entryPoints: ['src/analysis/index.ts'], outfile: '.test-dist/render-analyzer.cjs', bundle: true, platform: 'node', target: 'node18', format: 'cjs', keepNames: true, plugins: [parserPlugin] });
const { analyzeWorkspace } = createRequire(import.meta.url)('../.test-dist/render-analyzer.cjs');
const directory = path.resolve(process.argv[2]);
const graph = await analyzeWorkspace([{ id: 'preview', name: path.basename(directory), path: directory }], { exclude: ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache'] }, []);
const focus = graph.nodes.find(node => node.file?.path === 'src/pages/index.tsx') ?? graph.nodes.find(node => ['.tsx', '.ts', '.jsx', '.js'].includes(node.format));
assert(focus, 'Preview needs a source file');
const state = { type: 'state', graph, view: { mode: 'file', focusId: focus.id, follow: false, depth: 1, hideExternal: true, hideTests: false, groupBy: 'none', collapseReexports: false }, status: 'Контрольный проект: анализ завершён', annotations: undefined };
const script = `const state=${JSON.stringify(state).replace(/</g, '\\u003c')};window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:message=>{if(message.type==='setView')state.view=message.view;if(message.type==='ready'||message.type==='setView')setTimeout(()=>window.postMessage(state,'*'),0);}});`;
const html = `<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/styles.css"></head><body class="vscode-dark" style="--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd;--vscode-sideBar-background:#252526;--vscode-input-background:#333;--vscode-input-foreground:#eee;--vscode-panel-border:#555;--vscode-button-background:#0e639c;--vscode-button-secondaryBackground:#444;--vscode-font-family:Segoe UI;--vscode-font-size:13px"><script>${script}</script><script src="/webview.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  const name = request.url === '/webview.js' ? 'webview.js' : request.url === '/styles.css' ? 'styles.css' : undefined;
  if (!name) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : 'text/css');
  response.end(await readFile(path.join('dist', name)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const started = performance.now();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('.graph canvas') !== null);
  await page.waitForTimeout(400);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/project-file-map.png', fullPage: true });
  await page.getByLabel('Режим', { exact: true }).selectOption('project');
  await page.getByRole('button', { name: 'Раскладка', exact: true }).click();
  await page.getByRole('button', { name: 'Вписать', exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/project-full-map.png', fullPage: true });
  assert.deepEqual(errors, [], 'Real project graph has no browser exceptions');
  console.log(JSON.stringify({ files: graph.stats.files, relations: graph.relations.length, previewMs: Math.round(performance.now() - started), focus: focus.file?.path, screenshots: ['project-file-map.png', 'project-full-map.png'] }));
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
