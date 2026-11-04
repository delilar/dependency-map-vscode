import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

await mkdir('.test-dist-ux', { recursive: true });
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['src/webview/main.ts'], outfile: '.test-dist-ux/ui-audit.js', bundle: true, platform: 'browser', target: 'es2022', format: 'iife' });
const paths = ['A.ts', 'B.ts', 'Card.vue', ...Array.from({ length: 101 }, (_, i) => `targets/Target${i}.ts`)];
const nodes = paths.map((path, i) => ({ id: `file:app:${path}`, label: path.split('/').pop(), kind: 'file', projectId: i === 1 ? 'other' : 'app', projectName: i === 1 ? 'Other' : 'Web app', format: path.endsWith('.vue') ? '.vue' : '.ts', role: i === 0 || i === 2 ? 'component' : 'utility', file: { rootId: 'app', path } }));
const relations = nodes.slice(2).map((node, i) => ({ id: `edge:${i}`, sourceId: nodes[0].id, targetId: node.id, kind: 'import', certainty: 'confirmed', specifier: './' + node.label, bindings: i ? [] : [{ imported: 'Card', local: 'Card', resolvedImported: 'default', typeOnly: false }], evidence: [{ rule: 'Controlled UI audit fixture' }] }));
const fixture = { type: 'state', graph: { revision: 1, nodes, relations, unresolved: [], diagnostics: [], exports: [{ fileId: nodes[2].id, name: 'default', namespace: 'value', kind: 'direct' }], stats: { files: nodes.length, relations: relations.length, elapsedMs: 1 } }, view: { mode: 'project', focusId: nodes[0].id, follow: false, depth: 1, hideExternal: true, hideTests: false, groupBy: 'none', collapseReexports: false, activeGroupId: 'task' }, status: 'Controlled UI fixture', annotations: { version: 1, roots: [{ id: 'app', label: 'Web app' }], groups: [{ id: 'task', name: 'Task', color: '#eab308', files: nodes.slice(0, 2).map(node => ({ file: node.file, note: 'Saved note' })), relations: [] }] }, analytics: { index: { version: { epoch: 'audit', revision: 1, scopeRevision: 0 }, state: 'ready', reasonCodes: [] }, runtime: { host: { extensionVersion: '0.2.1', buildId: 'development', protocolVersion: 3, capabilities: [] }, compatible: true, installedVersion: '0.2.1', reasonCodes: [] }, branches: [], taskContexts: { savedGroupIds: [], orphanedGroupIds: [] } } };
const bootstrap = `window.harness={state:${JSON.stringify(fixture)},messages:[],failSave:false};let saved={format:'.ts',project:'app',role:'component'};const publish=()=>window.postMessage(structuredClone(window.harness.state),'*');window.harness.publish=publish;window.acquireVsCodeApi=()=>({getState:()=>saved,setState:value=>{saved=value;window.harness.saved=value},postMessage:message=>{const h=window.harness;h.messages.push(structuredClone(message));if(message.type==='ready'){h.state.analytics.runtime.host=message.build;setTimeout(publish,0)}if(message.type==='setView'){h.state.view=structuredClone(message.view);setTimeout(publish,0)}if(message.type==='annotation'&&message.requestId){const ok=!h.failSave;if(ok&&message.action==='note'){for(const mark of h.state.annotations.groups[0].files)if(message.nodeIds.includes('file:app:'+mark.file.path))mark.note=message.note;}setTimeout(()=>{publish();window.postMessage({type:'annotationResult',requestId:message.requestId,ok,action:message.action,files:ok?message.nodeIds.length:0,relations:0,skipped:0,message:ok?'Saved':'Controlled write failure'},'*')},0)}}});`;
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><body class="vscode-dark" style="--vscode-editor-background:#181e27;--vscode-editor-foreground:#d5dde8;--vscode-sideBar-background:#202734;--vscode-descriptionForeground:#a5b2c5;--vscode-input-background:#151b25;--vscode-input-foreground:#dce6f3;--vscode-button-secondaryBackground:#344354;--vscode-focusBorder:#6da9ff;--vscode-font-family:Segoe UI;--vscode-font-size:13px"><script>${bootstrap}</script><script src="/audit.js"></script>`;
const server = createServer(async (request, response) => {
  const resource = request.url === '/audit.js' ? ['.test-dist-ux/ui-audit.js', 'text/javascript'] : request.url === '/styles.css' ? ['src/webview/styles.css', 'text/css'] : undefined;
  try { response.setHeader('Content-Type', resource?.[1] ?? 'text/html; charset=utf-8'); response.end(resource ? await readFile(resource[0]) : html); }
  catch { response.statusCode = 500; response.end('Controlled fixture unavailable'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const outcomes = [];
async function scenario(name, run) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try { await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => document.querySelector('select[aria-label="Формат"]')?.value === '.ts'); await run(page); assert.deepEqual(errors, []); outcomes.push({ name, ok: true }); }
  catch (error) { outcomes.push({ name, ok: false, error: error.message }); }
  finally { await page.close(); }
}
async function clearFilters(page) { if (!await page.locator('.advanced-filters').evaluate(node => node.open)) await page.locator('.advanced-filters > summary').click(); for (const label of ['Формат', 'Приложение', 'Роль файла']) await page.getByLabel(label, { exact: true }).selectOption(''); }
try {
  await scenario('cleared filters survive host publication', async page => {
    await clearFilters(page); await page.evaluate(() => window.harness.publish());
    await page.waitForFunction(() => document.querySelector('select[aria-label="Формат"]')?.value === '');
    assert.deepEqual(await Promise.all(['Формат', 'Приложение', 'Роль файла'].map(label => page.getByLabel(label, { exact: true }).inputValue())), ['', '', '']);
  });
  await scenario('dirty note Stay preserves selection and text', async page => {
    await clearFilters(page); await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    await page.getByLabel('Заметка', { exact: true }).fill('Unsaved note');
    await page.getByRole('button', { name: 'B.ts', exact: true }).click();
    await page.getByRole('dialog', { name: 'Несохранённые свойства или заметка' }).waitFor();
    await page.getByRole('button', { name: 'Остаться', exact: true }).click();
    assert.equal(await page.getByLabel('Заметка', { exact: true }).inputValue(), 'Unsaved note');
    assert.equal(await page.locator('.details h3').first().textContent(), 'A.ts');
  });
  await scenario('Symbol action uses physical default binding', async page => {
    await clearFilters(page); await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    await page.getByRole('button', { name: 'Card.vue · import', exact: true }).click();
    await page.getByRole('button', { name: 'Фокус: Card', exact: true }).click();
    const request = await page.evaluate(() => window.harness.messages.find(message => message.type === 'startQuery'));
    assert.equal(request.query.fileId, nodes[2].id); assert.equal(request.query.exported, 'default');
  });
  await scenario('note Save failure keeps draft; successful retry changes selection', async page => {
    await clearFilters(page); await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    await page.getByLabel('Заметка', { exact: true }).fill('Retry note');
    await page.evaluate(() => { window.harness.failSave = true; });
    await page.getByRole('button', { name: 'B.ts', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.details h3')?.textContent === 'A.ts' && !document.querySelector('dialog'));
    assert.equal(await page.getByLabel('Заметка', { exact: true }).inputValue(), 'Retry note');
    await page.evaluate(() => { window.harness.failSave = false; });
    await page.getByRole('button', { name: 'B.ts', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.details h3')?.textContent === 'B.ts');
    assert.equal(await page.evaluate(() => window.harness.state.annotations.groups[0].files[0].note), 'Retry note');
  });
  await scenario('canvas selection Discard is coherent and keyboard state is exposed', async page => {
    await clearFilters(page); await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    await page.getByLabel('Заметка', { exact: true }).fill('Discard me');
    await page.evaluate(id => { const cy = document.querySelector('.graph')._cyreg.cy; cy.batch(() => { cy.elements(':selected').unselect(); cy.getElementById(id).select(); }); }, nodes[1].id);
    await page.getByRole('dialog').getByRole('button', { name: 'Отбросить', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.details h3')?.textContent === 'B.ts');
    assert.equal(await page.getByRole('button', { name: 'B.ts', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    assert.equal(await page.getByLabel('Заметка', { exact: true }).inputValue(), 'Saved note');
  });
  await scenario('reindex removal keeps a recoverable draft', async page => {
    await clearFilters(page); await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    await page.getByLabel('Заметка', { exact: true }).fill('Keep after deletion');
    await page.evaluate(id => { const h = window.harness; h.state.graph.nodes = h.state.graph.nodes.filter(node => node.id !== id); h.state.graph.relations = []; h.state.graph.revision++; h.publish(); }, nodes[0].id);
    await page.getByRole('button', { name: 'Несохранённые заметки (1)', exact: true }).click();
    assert.equal(await page.getByRole('dialog').getByLabel('Текст несохранённой заметки').inputValue(), 'Keep after deletion');
  });
  await scenario('scope editor hydrates independent applied scopes and retains other roots', async page => {
    await page.locator('.scope-controls > summary').click();
    const target = page.getByLabel('Редактируемая область', { exact: true });
    const folders = page.getByLabel('Папки (по одной на строку)', { exact: true });
    await folders.fill('targets'); await page.getByRole('button', { name: 'Применить область', exact: true }).click();
    await target.selectOption('presentationScope'); assert.equal(await folders.inputValue(), '.');
    await folders.fill('.'); await page.getByRole('button', { name: 'Применить область', exact: true }).click();
    await target.selectOption('queryScope'); assert.equal(await folders.inputValue(), 'targets');
    await page.evaluate(() => { const h = window.harness; h.state.graph.nodes.push({ id: 'other-file', label: 'Other.ts', kind: 'file', projectId: 'other', projectName: 'Other root', format: '.ts', file: { rootId: 'other', path: 'feature/Other.ts' } }); h.publish(); });
    await page.getByLabel('Корень области', { exact: true }).selectOption('other');
    await folders.fill('feature'); await page.getByRole('button', { name: 'Применить область', exact: true }).click();
    const scope = await page.evaluate(() => window.harness.state.view.queryScope);
    assert.deepEqual(scope.folders, [{ rootId: 'app', path: 'targets' }, { rootId: 'other', path: 'feature' }]);
    await page.getByLabel('Корень области', { exact: true }).selectOption('app'); assert.equal(await folders.inputValue(), 'targets');
  });
  await scenario('project empty state explains disjoint display and analysis scopes', async page => {
    await page.evaluate(() => { const h = window.harness; h.state.view.presentationScope = { version: 1, folders: [{ rootId: 'app', path: 'A.ts' }], excludeRoles: [] }; h.state.view.queryScope = { version: 1, folders: [{ rootId: 'app', path: 'targets' }], excludeRoles: [] }; h.publish(); });
    await page.getByText('Области показа и анализа не пересекаются. Измените одну из областей.', { exact: true }).waitFor();
  });
  await scenario('all relation rows remain reachable after the first hundred', async page => {
    await clearFilters(page); await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Target100.ts · import', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Показать ещё связи (2)', exact: true }).click();
    await page.getByRole('button', { name: 'Target100.ts · import', exact: true }).waitFor();
  });
  await scenario('narrow pane navigation retains note draft and desktop dimensions', async page => {
    await clearFilters(page); await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    await page.setViewportSize({ width: 420, height: 900 });
    await page.getByRole('button', { name: 'Задача', exact: true }).click();
    assert((await page.locator('.tasks-panel').boundingBox()).width >= 400);
    await page.getByLabel('Заметка', { exact: true }).fill('Pane draft');
    await page.getByRole('button', { name: 'Поиск', exact: true }).click();
    assert((await page.locator('.sidebar').boundingBox()).width >= 400);
    await page.getByRole('button', { name: 'Задача', exact: true }).click();
    assert.equal(await page.getByLabel('Заметка', { exact: true }).inputValue(), 'Pane draft');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'artifacts/ui-audit-narrow.png' });
  });
  await scenario('editor font setting scales controls and graph labels without resetting zoom', async page => {
    await clearFilters(page); await page.getByRole('button', { name: 'A.ts', exact: true }).click();
    const control = page.getByRole('button', { name: 'Открыть файл', exact: true });
    const before = await control.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    const zoom = await page.evaluate(() => document.querySelector('.graph')._cyreg.cy.zoom());
    await page.evaluate(() => document.body.style.setProperty('--vscode-font-size', '20px'));
    await page.waitForFunction(() => parseFloat(document.querySelector('.graph')._cyreg.cy.nodes().first().style('font-size')) > 15);
    assert(await control.evaluate(node => parseFloat(getComputedStyle(node).fontSize)) > before * 1.4);
    assert.equal(await page.evaluate(() => document.querySelector('.graph')._cyreg.cy.zoom()), zoom);
    for (const width of [900, 420]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 420) await page.getByRole('button', { name: 'Детали', exact: true }).click();
      assert(await control.isVisible());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.screenshot({ path: 'artifacts/ui-audit-large-font.png' });
  });
  await writeFile('artifacts/ui-audit.json', JSON.stringify({ checkedAt: new Date().toISOString(), outcomes }, null, 2) + '\n');
  console.log(JSON.stringify(outcomes)); assert(outcomes.every(outcome => outcome.ok), 'UI audit regression failed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
