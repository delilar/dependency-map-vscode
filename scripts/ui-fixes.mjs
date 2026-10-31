import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

await mkdir('.test-dist', { recursive: true });
await build({ stdin: { resolveDir: process.cwd(), contents: `
import {GraphCanvas,projectGraph,groupProjection} from './src/webview/graph';
import {createGraphAppearance} from './src/webview/appearance';
const ids=['A','B','C','D'].map(name=>'file:app:src/'+name+(name==='B'?'.json':'.tsx'));
const nodes=ids.map((id,index)=>({id,label:['A.tsx','B.json','C.tsx','D.tsx'][index],kind:'file',projectId:'app',format:index===1?'.json':'.tsx',file:{rootId:'app',path:id.split('file:app:')[1]}}));
const relations=[[0,1],[1,2],[0,3]].map(([source,target],index)=>({id:'edge'+index,sourceId:ids[source],targetId:ids[target],kind:'import',certainty:'confirmed',specifier:'./'+target,bindings:[],evidence:[]}));
const graph={revision:1,nodes,relations,unresolved:[],diagnostics:[],stats:{files:4,relations:3,elapsedMs:0}};
let view={mode:'file',focusId:ids[0],follow:false,depth:2,hideExternal:true,hideTests:false,groupBy:'none',collapseReexports:false};
const group={id:'task',name:'Task',color:'#ef4444',files:[{file:nodes[0].file}],relations:[{source:nodes[0].file,target:nodes[1].file,kind:'import',specifier:'./1'}]};
let canvas;
function create(restored={}){
 if(canvas)canvas.destroy();document.getElementById('graph').replaceChildren();
 canvas=new GraphCanvas(document.getElementById('graph'),{selection:value=>window.selection=value,open:()=>{},toggleGroup:()=>{},context:(id,point)=>window.context={id,point},save:value=>window.saved=value},restored);
 render();
}
function render(){const projection=groupProjection(projectGraph(graph,view),view.groupBy,new Set());canvas.render(projection,view,createGraphAppearance(graph,group,projection.groups));}
window.harness={ids,create,render,get cy(){return canvas.cy},get view(){return view},get canvas(){return canvas},setView(patch){view={...view,...patch};render()}};
create();
` }, outfile: '.test-dist/ui-fixes.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome108' });
const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body class="vscode-dark" style="--vscode-editor-background:#181e27;--vscode-editor-foreground:#d5dde8;--vscode-focusBorder:#6da9ff"><div id="graph" class="graph" style="height:100vh;width:100vw"></div><script src="/harness.js"></script></body></html>';
const server = createServer(async (request, response) => {
  try {
    const file = request.url === '/harness.js' ? ['.test-dist/ui-fixes.js', 'text/javascript'] : request.url === '/styles.css' ? ['dist/styles.css', 'text/css'] : undefined;
    response.setHeader('Content-Type', file ? file[1] : 'text/html; charset=utf-8');
    response.end(file ? await readFile(file[0]) : html);
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.harness?.cy.nodes().length === 4);
  assert.equal(await page.evaluate(() => window.harness.cy.zoom()), 1, 'Fresh file map starts at readable scale');
  const colors = await page.evaluate(() => {
    const { cy, ids } = window.harness; cy.getElementById('edge0').select(); cy.getElementById(ids[0]).select();
    return { line: cy.getElementById('edge0').style('line-color'), arrow: cy.getElementById('edge0').style('target-arrow-color'),
      halo: Number(cy.getElementById('edge0').style('underlay-opacity')), border: cy.getElementById(ids[0]).style('border-color'),
      firstFill: cy.getElementById(ids[0]).style('background-color'), secondFill: cy.getElementById(ids[1]).style('background-color'), secondBorder: cy.getElementById(ids[1]).data('border') };
  });
  assert.equal(colors.line, 'rgb(239,68,68)'); assert.equal(colors.arrow, colors.line); assert.equal(colors.border, colors.line);
  assert(colors.halo > 0, 'Selection has an independent halo'); assert.notEqual(colors.firstFill, colors.secondFill);
  assert.equal(colors.secondBorder, undefined, 'Relation mark does not mark endpoints');

  const point = { x: 720, y: 440 };
  const before = await page.evaluate(point => { const cy = window.harness.cy; return { zoom: cy.zoom(), model: { x: (point.x - cy.pan().x) / cy.zoom(), y: (point.y - cy.pan().y) / cy.zoom() } }; }, point);
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -100); await page.waitForTimeout(350);
  const after = await page.evaluate(point => { const cy = window.harness.cy; return { zoom: cy.zoom(), model: { x: (point.x - cy.pan().x) / cy.zoom(), y: (point.y - cy.pan().y) / cy.zoom() } }; }, point);
  assert(after.zoom > before.zoom * 1.15, `First wheel step responds at calibrated sensitivity: ${JSON.stringify({ before, after })}`);
  assert(Math.abs(before.model.x - after.model.x) < 0.01 && Math.abs(before.model.y - after.model.y) < 0.01, 'Wheel remains anchored at cursor');
  for (let index = 0; index < 3; index++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(40); }
  await page.evaluate(() => window.harness.cy.zoom(1));
  await page.mouse.wheel(0, -100); await page.waitForTimeout(200);
  const calibrated = await page.evaluate(() => window.harness.cy.zoom());
  assert(calibrated >= 1.08 && calibrated <= 1.25, `Normalized mouse wheel remains responsive after device sampling: ${calibrated}`);

  await page.evaluate(() => { const { cy } = window.harness; cy.zoom(0.12); cy.pan({ x: 5, y: 8 }); window.harness.canvas.center(window.harness.ids[1]); });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.harness.cy.zoom()), 1, 'Explicit file focus repairs a tiny overview scale');
  const position = await page.evaluate(() => window.harness.cy.getElementById(window.harness.ids[1]).renderedPosition());
  assert(Math.abs(position.x - 600) < 1 && Math.abs(position.y - 400) < 1, 'File focus is centered at new zoom');

  const camera = await page.evaluate(() => { const { cy } = window.harness; cy.zoom(1.3); cy.pan({ x: 71, y: 42 }); window.harness.render(); return { zoom: cy.zoom(), pan: cy.pan() }; });
  await page.setViewportSize({ width: 940, height: 620 }); await page.waitForTimeout(120);
  assert.deepEqual(await page.evaluate(() => ({ zoom: window.harness.cy.zoom(), pan: window.harness.cy.pan() })), camera, 'Projection updates and resize preserve camera');
  const click = await page.evaluate(() => { const { cy, ids } = window.harness; cy.zoom(1); cy.center(cy.getElementById(ids[0])); return cy.getElementById(ids[0]).renderedPosition(); });
  await page.mouse.click(click.x, click.y, { button: 'right' });
  assert.equal(await page.evaluate(() => window.context?.id), 'file:app:src/A.tsx', 'Canvas right click reaches real file context action');

  await page.evaluate(() => window.harness.create({ zoom: 0.15, pan: { x: 23, y: 18 } }));
  assert.deepEqual(await page.evaluate(() => ({ zoom: window.harness.cy.zoom(), pan: window.harness.cy.pan() })), { zoom: 0.15, pan: { x: 23, y: 18 } }, 'Restore retains intentional tiny camera exactly');
  await page.evaluate(() => window.harness.setView({ groupBy: 'folder' }));
  assert(await page.evaluate(() => window.harness.cy.nodes('[group]').every(node => !!node.data('folderColor'))), 'Folder groups have stable colors');
  assert.deepEqual(errors, []);
  console.log('UI fixes passed: readable start/focus, selected task colors, independent format fills, cursor zoom, canvas context action, exact restore and resize.');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
