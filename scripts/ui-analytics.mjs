import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

await mkdir('.test-dist', { recursive: true });
await build({ entryPoints: ['src/webview/main.ts'], outfile: '.test-dist/ui-analytics.js', bundle: true, platform: 'browser', target: 'es2022', format: 'iife' });
const bootstrap = `
const ids=['A','B','C','check'].map(n=>'file:root:src/'+n+(n==='check'?'.test.js':'.ts'));
const graph={revision:1,nodes:ids.map((id,i)=>({id,label:['A.ts','B.ts','C.ts','check.test.js'][i],kind:'file',projectId:'app',projectName:'App',format:i===3?'.js':'.ts',role:i===3?'test':'utility',file:{rootId:'root',path:id.slice(10)}})),
 relations:[[0,1],[1,2],[3,0]].map(([s,t],i)=>({id:'e'+i,sourceId:ids[s],targetId:ids[t],kind:'import',certainty:'confirmed',specifier:'./'+['B','C','A'][i],bindings:i===0?[{imported:'foo',local:'localFoo',typeOnly:false}]:[],evidence:[{rule:'ESM import',range:{start:{line:i,character:0},end:{line:i,character:10}}}]})),unresolved:[],diagnostics:[],stats:{files:4,relations:3,elapsedMs:1},exports:[{fileId:ids[1],name:'foo',namespace:'value',kind:'direct'}],coverage:[]};
const view={mode:'file',focusId:ids[0],follow:true,depth:1,hideExternal:true,hideTests:false,groupBy:'none',collapseReexports:false,activeGroupId:'task'};
const annotations={version:1,roots:[{id:'root',label:'App'}],groups:[{id:'task',name:'My task',color:'#00aa88',files:[{file:graph.nodes[1].file}],relations:[]}]};
const version={epoch:'ui-test',revision:1,scopeRevision:1};
let state={type:'state',graph,view,status:'Ready',annotations};
let savedContext; let restoreToken=0;
window.sent=[]; window.failSave=false;
const send=()=>window.postMessage(structuredClone(state),'*');
const result=(query,requestId)=>{
 const base={type:'queryResult',requestId,graph:version,operation:'success',coverage:'complete',freshness:'current',reasonCodes:[],limits:{maxNodes:10000,maxRelations:50000,deadlineMs:1500},visitedNodes:4,examinedRelations:3,nodeIds:[...ids],relationIds:['e0','e1','e2'],witnesses:[]};
 if(query.kind==='impact')return {...base,kind:'impact',outcome:'found',directIds:[ids[0]],indirectIds:[ids[3]],testIds:[ids[3]],nodeIds:[ids[1],ids[0],ids[3]],relationIds:['e0','e2'],witnesses:[{nodeId:ids[0],nodeIds:[ids[1],ids[0]],relationIds:['e0'],depth:1},{nodeId:ids[3],nodeIds:[ids[1],ids[0],ids[3]],relationIds:['e0','e2'],depth:2}]};
 if(query.kind==='path')return {...base,kind:'path',outcome:query.fromId===query.toId?'found':'found',nodeIds:query.fromId===query.toId?[query.fromId]:[query.fromId,query.toId],relationIds:query.fromId===query.toId?[]:['e0'],witnesses:[{nodeId:query.toId,nodeIds:query.fromId===query.toId?[query.fromId]:[query.fromId,query.toId],relationIds:query.fromId===query.toId?[]:['e0'],depth:query.fromId===query.toId?0:1}]};
 return {...base,kind:'symbol',outcome:'ambiguous',nodeIds:[ids[0],ids[1]],relationIds:['e0'],resolution:{status:'ambiguous',reasonCodes:['partialStarBranch'],candidates:[{fileId:ids[1],name:'foo',namespace:'value',relationIds:[]}]}};
};
window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:next=>{window.localState=next;},postMessage:message=>{
 window.sent.push(message);
 if(message.type==='ready'){
  state.analytics={index:{version,state:'ready',reasonCodes:[]},runtime:{host:message.build,webview:message.build,worker:message.build,installedVersion:'0.2.0',compatible:true,reasonCodes:[]},branches:[],taskContexts:{savedGroupIds:[],orphanedGroupIds:[]},git:{gitRevision:1,providerState:'available',observedAt:1,repositories:[{id:'repo',label:'Repo',state:'available'}],rows:[{id:'change',repoId:'repo',relativePath:'src/B.ts',staged:true,unstaged:true,untracked:false,conflict:false,dirty:true,indexedNodeId:ids[1],scopeStatus:'indexed'}],omissions:0,reasonCodes:[]}};setTimeout(send,0);
 }
 if(message.type==='setView'){state.view=message.view;send();}
 if(message.type==='startQuery'){state.view={...state.view,follow:false};const requestId='q'+window.sent.length;state.analytics.active={requestId,query:message.query,state:'ready',result:result(message.query,requestId)};send();}
 if(message.type==='leaveAnalysis'){delete state.analytics.active;send();}
 if(message.type==='branch'){
  const id=message.nodeId+':'+message.direction; state.analytics.branches=state.analytics.branches.filter(b=>b.id!==id);
  if(message.action==='expand')state.analytics.branches.push({id,anchorId:message.nodeId,direction:message.direction,depth:1,result:{...result({kind:'path',fromId:ids[1],toId:ids[2]},id),kind:'neighbourhood',nodeIds:[ids[1],ids[2]],relationIds:['e1']}});send();
 }
 if(message.type==='taskContext'){
  if(message.action==='save'){savedContext=message.data;state.analytics.taskContexts.savedGroupIds=['task'];state.analytics.taskContexts.message='Локальный вид сохранён.';}
  if(message.action==='preview')state.analytics.taskContexts.preview={groupId:'task',savedAt:1,missingNodeIds:[],groupChanged:false,groupMissing:false,reasonCodes:[],data:savedContext};
  if(message.action==='restore'){state.view={...savedContext.view,follow:false};delete state.analytics.active;state.analytics.uiStateToken=String(++restoreToken);state.analytics.taskContexts.restore={token:state.analytics.uiStateToken,data:savedContext};}
  if(message.action==='delete'){state.analytics.taskContexts={savedGroupIds:[],orphanedGroupIds:[],message:'Локальный вид удалён.'};}
  send();
 }
 if(message.type==='annotation'){
  if(!window.failSave){const group=annotations.groups[0];if(message.name)group.name=message.name;if(message.color)group.color=message.color;send();}
  setTimeout(()=>window.postMessage({type:'annotationResult',requestId:message.requestId,action:message.action,ok:!window.failSave,files:0,relations:0,skipped:0,message:window.failSave?'Ошибка сохранения':'Сохранено'},'*'),0);
 }
 if(message.type==='diagnostics'&&message.action==='preview')setTimeout(()=>window.postMessage({type:'diagnostics',text:'Dependency Map 0.2.0\\nFiles: 4\\nNo source content'},'*'),0);
}});
window.harness={ids,graph,get state(){return state;},send,mismatch(){state.analytics.runtime.compatible=false;state.analytics.runtime.reasonCodes=['buildMismatch'];send();},stale(){state.analytics.index.state='stale';state.analytics.active.state='stale';state.analytics.active.result.freshness='stale';send();}};
`;
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body class="vscode-dark" style="--vscode-editor-background:#181e27;--vscode-editor-foreground:#d5dde8;--vscode-focusBorder:#6da9ff"><script>${bootstrap}</script><script src="/main.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  try {
    const file = request.url === '/main.js' ? ['.test-dist/ui-analytics.js', 'text/javascript'] : request.url === '/styles.css' ? ['src/webview/styles.css', 'text/css'] : undefined;
    response.setHeader('Content-Type', file?.[1] ?? 'text/html; charset=utf-8'); response.end(file ? await readFile(file[0]) : html);
  } catch { response.statusCode = 500; response.end('Fixture unavailable'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.advanced-filters > summary').click();
  await page.getByRole('button', { name: 'B.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Ещё исходящие', exact: true }).click();
  await page.waitForFunction(() => window.sent.some(m => m.type === 'branch' && m.direction === 'outgoing'));
  await page.getByRole('button', { name: 'C.ts', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'C.ts', exact: true }).count(), 'Directed branch contributes C to A radius 1');
  await page.getByRole('button', { name: 'Свернуть исходящую ветку', exact: true }).click();
  await page.waitForFunction(() => !window.harness.state.analytics.branches.length);
  await page.getByRole('button', { name: 'C.ts', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'C.ts', exact: true }).count(), 0);
  await page.getByLabel('Формат', { exact: true }).selectOption('.ts');
  await page.getByRole('button', { name: 'Кто может зависеть от изменения', exact: true }).click();
  await page.getByText('Прямых: 1 · косвенных: 1 · тестов-кандидатов: 1', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.harness.state.view.follow), false, 'Starting analysis pins focus');
  assert(await page.locator('.query-row').filter({ hasText: 'check.test.js · тест-кандидат · скрыт' }).count(), 'Filtered test remains in full-index result');
  await page.locator('.query-row').filter({ hasText: 'check.test.js · тест-кандидат · скрыт' }).getByRole('button', { name: 'Показать цепочку', exact: true }).click();
  assert.equal(await page.getByLabel('Формат', { exact: true }).inputValue(), '.ts', 'Explicit reveal does not silently reset filters');
  await page.evaluate(() => window.harness.stale());
  await page.getByText('результат устарел', { exact: false }).first().waitFor();
  await page.evaluate(() => { window.harness.state.analytics.index.state = 'ready'; window.harness.send(); });
  await page.getByRole('button', { name: 'Вернуться к обычной карте', exact: true }).click();
  await page.getByRole('button', { name: 'B.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Путь отсюда…', exact: true }).click();
  await page.getByLabel('Откуда', { exact: true }).selectOption(await page.evaluate(() => window.harness.ids[0]));
  await page.getByLabel('Куда', { exact: true }).selectOption(await page.evaluate(() => window.harness.ids[1]));
  await page.getByRole('button', { name: 'Найти направленный путь', exact: true }).click();
  await page.waitForFunction(() => window.harness.state.analytics.active.query.kind === 'path');
  await page.locator('.query-summary').filter({ hasText: 'Путь импортов' }).waitFor();
  await page.locator('.query-results').filter({ hasText: 'A.ts' }).waitFor();
  assert((await page.locator('.query-results').textContent()).includes('A.ts'), 'Path lists actual files');
  await page.getByRole('button', { name: 'Вернуться к обычной карте', exact: true }).click();
  await page.getByRole('button', { name: 'B.ts', exact: true }).click();
  await page.getByText('Экспорты (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'foo — фокус символа', exact: true }).click();
  await page.getByText('Символ неоднозначен — точная декларация не выбрана', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.harness.state.analytics.active.query.fileId), await page.evaluate(() => window.harness.ids[1]));
  await page.getByRole('button', { name: 'Вернуться к обычной карте', exact: true }).click();
  await page.getByText('Текущие изменения Git', { exact: true }).click();
  await page.getByText('staged · unstaged · несохранённый редактор · indexed', { exact: true }).waitFor();
  await page.getByText('Мой вид задачи (локально)', { exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить мой вид', exact: true }).click();
  await page.getByRole('button', { name: 'Предпросмотр сохранённого вида', exact: true }).click();
  await page.getByRole('button', { name: 'Восстановить доступную часть', exact: true }).waitFor();
  await page.getByLabel('Название группы', { exact: true }).fill('Unsaved task');
  await page.getByRole('button', { name: 'Восстановить доступную часть', exact: true }).click();
  await page.getByRole('dialog', { name: 'Несохранённые свойства или заметка' }).getByRole('button', { name: 'Остаться', exact: true }).click();
  assert.equal(await page.getByLabel('Название группы', { exact: true }).inputValue(), 'Unsaved task');
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'taskContext' && m.action === 'restore').length), 0);
  await page.evaluate(() => { window.failSave = true; });
  await page.getByRole('button', { name: 'Восстановить доступную часть', exact: true }).click();
  await page.getByRole('dialog', { name: 'Несохранённые свойства или заметка' }).getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByText('Ошибка сохранения', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Название группы', { exact: true }).inputValue(), 'Unsaved task');
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'taskContext' && m.action === 'restore').length), 0, 'Failed group save blocks restore');
  await page.getByRole('button', { name: 'Восстановить доступную часть', exact: true }).click();
  await page.getByRole('dialog', { name: 'Несохранённые свойства или заметка' }).getByRole('button', { name: 'Отбросить', exact: true }).click();
  await page.waitForFunction(() => window.sent.some(m => m.type === 'taskContext' && m.action === 'restore'));
  await page.waitForFunction(() => window.sent.some(m => m.type === 'saveLocalState' && m.contextToken === window.harness.state.analytics.uiStateToken));
  assert.equal(await page.evaluate(() => window.harness.state.view.follow), false);
  await page.getByText('Диагностика (0) · неразрешённых обращений 0', { exact: true }).click();
  await page.getByText('Версии и актуальность', { exact: true }).click();
  await page.getByRole('button', { name: 'Просмотреть диагностику', exact: true }).click();
  await page.getByRole('dialog', { name: 'Предпросмотр диагностических сведений' }).waitFor();
  await page.getByRole('button', { name: 'Скопировать просмотренную диагностику', exact: true }).click();
  assert(await page.evaluate(() => window.sent.some(m => m.type === 'diagnostics' && m.action === 'copy')));
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Кто может зависеть от изменения', exact: true }).click();
  await mkdir('artifacts', { recursive: true });
  for (const [width, height, theme] of [[1600,1000,'dark'],[860,900,'high-contrast'],[640,900,'light'],[420,300,'dark']]) {
    await page.evaluate(theme => {
      document.body.className='vscode-'+theme;
      document.body.style.setProperty('--vscode-editor-background',theme==='light'?'#f6f7f9':'#181e27');
      document.body.style.setProperty('--vscode-editor-foreground',theme==='light'?'#18212a':'#d5dde8');
      document.body.style.setProperty('--vscode-descriptionForeground',theme==='light'?'#455568':'#a2a9b0');
      document.body.style.setProperty('--vscode-contrastBorder',theme==='high-contrast'?'#fff':'');
    }, theme);
    await page.setViewportSize({ width, height }); await page.waitForTimeout(80);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No viewport horizontal overflow');
    assert(await page.getByRole('button', { name: 'Пересчитать', exact: true }).count());
    await page.getByRole('button', { name: 'Вписать', exact: true }).click(); await page.waitForTimeout(180);
    const inViewport = await page.evaluate(() => { const cy=document.querySelector('.graph')._cyreg.cy; return cy.nodes().some(n=>{const p=n.renderedPosition();return p.x>=0&&p.y>=0&&p.x<=cy.width()&&p.y<=cy.height();}); });
    assert(inViewport, 'Explicit fit keeps graph reachable after viewport changes without automatic camera resets');
    await page.screenshot({ path: 'artifacts/ui-v020-'+width+'-'+theme+'.png' });
  }
  await page.evaluate(() => {
    const h = window.harness, state = h.state, anchor = h.ids[1];
    const extra = Array.from({ length: 600 }, (_, i) => ({ ...h.graph.nodes[1], id: 'file:root:extra/'+i+'.ts', label: 'Extra'+i, file: { rootId: 'root', path: 'extra/'+i+'.ts' } }));
    const edges = extra.map((node, i) => ({ ...h.graph.relations[0], id: 'extra:'+i, sourceId: anchor, targetId: node.id }));
    state.graph = { ...h.graph, revision: 2, nodes: [...h.graph.nodes, ...extra], relations: [...h.graph.relations, ...edges], stats: { files: 604, relations: 603, elapsedMs: 1 } };
    state.analytics.index.version.revision = 2;
    delete state.analytics.active;
    state.analytics.branches = [{ id: 'large', anchorId: anchor, direction: 'outgoing', depth: 1, result: { type: 'queryResult', requestId: 'large', graph: state.analytics.index.version, kind: 'neighbourhood', operation: 'success', outcome: 'found', coverage: 'complete', freshness: 'current', reasonCodes: [], limits: { maxNodes: 10000, maxRelations: 50000, deadlineMs: 1500 }, visitedNodes: 601, examinedRelations: 600, nodeIds: [anchor, ...extra.map(n => n.id)], relationIds: edges.map(e => e.id), witnesses: [] } }];
    h.send();
  });
  await page.waitForFunction(() => document.querySelector('.graph')._cyreg.cy.nodes().length === 500);
  assert(await page.getByText('Предел карты — 500 файлов. Часть ветки скрыта ограничением отображения, независимо от полноты запроса.', { exact: true }).count());
  await page.evaluate(() => window.harness.mismatch());
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(node => node.textContent === 'Оценить влияние выбранного файла' && node.disabled));
  assert(await page.getByRole('button', { name: 'Оценить влияние выбранного файла', exact: true }).isDisabled());
  assert.deepEqual(errors, []);
  console.log('Analytics UI passed: branches, full-index hidden test/evidence, stale/repeat, directed path, symbol ambiguity, cached Git, draft-safe task restore, diagnostics preview, handshake and responsive layouts.');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
