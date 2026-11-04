import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

await mkdir('.test-dist', { recursive: true });
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['src/webview/main.ts'], outfile: '.test-dist/ui-web-stack.js', bundle: true, platform: 'browser', target: 'es2022', format: 'iife' });
const paths = ['feature/A.vue', 'shared/B.ts', 'feature/C.ts', 'feature/theme.css', 'tests/A.test.ts', 'feature/Other.vue'];
const nodes = paths.map((path, index) => ({
  id: `file:${index === 5 ? 'other' : 'web'}:${path}`, label: path.split('/').pop(), kind: 'file',
  projectId: index === 5 ? 'project:other' : 'project:web', projectName: index === 5 ? 'Other app' : 'Web app',
  format: path.endsWith('.vue') ? '.vue' : path.endsWith('.css') ? '.css' : '.ts',
  family: path.endsWith('.vue') ? 'ui' : path.endsWith('.css') ? 'style' : 'code',
  languageId: path.endsWith('.vue') ? 'VUE' : path.endsWith('.css') ? 'CSS' : 'TS',
  role: index === 4 ? 'test' : index === 3 ? 'style' : 'component', file: { rootId: index === 5 ? 'other' : 'web', path },
}));
const fixture = {
  type: 'state', graph: {
    revision: 1, nodes,
    relations: [[0, 1], [1, 2], [0, 3], [4, 0]].map(([from, to], index) => ({ id: `edge:${index}`, sourceId: nodes[from].id, targetId: nodes[to].id,
      kind: index === 2 ? 'resource' : 'import', certainty: 'confirmed', specifier: './' + nodes[to].label, bindings: [], evidence: [{ rule: 'Controlled UI fixture' }] })),
    unresolved: [], diagnostics: [], stats: { files: nodes.length, relations: 4, elapsedMs: 1 },
  },
  view: { mode: 'file', focusId: nodes[0].id, follow: false, depth: 4, hideExternal: true, hideTests: false, groupBy: 'none', collapseReexports: false, activeGroupId: 'task' },
  status: 'Controlled web-stack UI fixture',
  annotations: { version: 1, roots: [{ id: 'web', label: 'Web app' }, { id: 'other', label: 'Other app' }], groups: [{ id: 'task', name: 'Web task', color: '#ef4444', files: [{ file: nodes[0].file }, { file: nodes[3].file }], relations: [] }] },
};
const bootstrap = `
const state=${JSON.stringify(fixture)};
window.harness={state, messages:[]}; let saved;
const send=()=>window.postMessage(structuredClone(state),'*');
window.acquireVsCodeApi=()=>({getState:()=>saved,setState:value=>{saved=value;window.harness.saved=value;},postMessage:message=>{
 window.harness.messages.push(structuredClone(message));
 if(message.type==='setView'){state.view=structuredClone(message.view);setTimeout(send,0);}
 if(message.type==='ready')setTimeout(send,0);
}});`;
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="vscode-dark" style="--vscode-editor-background:#181e27;--vscode-editor-foreground:#d5dde8;--vscode-sideBar-background:#202734;--vscode-descriptionForeground:#a5b2c5;--vscode-input-background:#151b25;--vscode-input-foreground:#dce6f3;--vscode-button-secondaryBackground:#344354;--vscode-button-background:#5689c9;--vscode-font-family:Segoe UI;--vscode-font-size:13px;--vscode-panel-border:#344153;--vscode-focusBorder:#6da9ff"><script>${bootstrap}</script><script src="/main.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  try {
    const file = request.url === '/main.js' ? ['.test-dist/ui-web-stack.js', 'text/javascript'] : request.url === '/styles.css' ? ['src/webview/styles.css', 'text/css'] : undefined;
    if (!file && request.url !== '/') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file?.[1] ?? 'text/html; charset=utf-8'); response.end(file ? await readFile(file[0]) : html);
  } catch { response.statusCode = 500; response.end('Controlled fixture unavailable'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('button', { name: 'A.vue', exact: true }).waitFor();
  await page.locator('.advanced-filters > summary').click();
  const visibleFiles = () => page.evaluate(() => document.querySelector('.graph')._cyreg.cy.nodes().filter(node => !node.data('group')).map(node => node.id()).sort());
  const colors = () => page.evaluate(() => Object.fromEntries(document.querySelector('.graph')._cyreg.cy.nodes().filter(node => !node.data('group')).map(node => [node.id(), { fill: node.data('fill'), label: node.data('label'), border: node.data('border') }])));
  assert.equal((await visibleFiles()).length, 5);
  const family = await colors();
  assert.equal(family[nodes[1].id].fill, family[nodes[2].id].fill, 'TS files share the code family');
  assert.notEqual(family[nodes[0].id].fill, family[nodes[1].id].fill, 'Vue UI differs from code');
  assert.notEqual(family[nodes[3].id].fill, family[nodes[1].id].fill, 'Styles differ from code');
  assert(family[nodes[0].id].label.includes('[VUE]'));
  assert.equal(family[nodes[0].id].border, '#ef4444', 'Task mark remains separate from format fill');
  await page.getByLabel('Цветовая схема', { exact: true }).selectOption('format');
  await page.waitForFunction(() => window.harness.state.view.colorPreset === 'format');
  assert.notEqual((await colors())[nodes[1].id].fill, family[nodes[1].id].fill);
  await page.getByLabel('Цветовая схема', { exact: true }).selectOption('family');
  await page.getByText('Области вида V и анализа Q', { exact: true }).click();
  await page.getByLabel('Редактируемая область', { exact: true }).selectOption('presentationScope');
  await page.getByLabel('Корень области', { exact: true }).selectOption('web');
  const folders = page.getByLabel('Папки (по одной на строку)', { exact: true });
  await folders.fill('feature');
  await page.getByRole('button', { name: 'Применить область', exact: true }).click();
  await page.waitForFunction(() => window.harness.state.view.presentationScope?.folders[0].path === 'feature');
  assert.deepEqual(await visibleFiles(), [nodes[0].id, nodes[2].id, nodes[3].id].sort(), 'V hides B without removing the path through it');
  assert.equal(await page.evaluate(() => window.harness.state.view.queryScope), undefined, 'V leaves the analytical scope unchanged');
  await page.getByLabel('Редактируемая область', { exact: true }).selectOption('queryScope');
  await folders.fill('feature');
  await page.getByRole('button', { name: 'Применить область', exact: true }).click();
  await page.waitForFunction(() => window.harness.state.view.queryScope?.folders[0].path === 'feature');
  assert.deepEqual(await visibleFiles(), [nodes[0].id, nodes[3].id].sort(), 'Q blocks the outside intermediary rather than inventing A to C');
  const search = page.getByRole('searchbox', { name: 'Поиск по всему индексу', exact: true });
  await search.fill('B.ts');
  await page.getByRole('button', { name: 'B.ts', exact: true }).click();
  assert(await page.getByText(/вне Q: предпросмотр/).count());
  assert(!(await visibleFiles()).includes(nodes[1].id), 'Outside search selection cannot force a node through Q');
  await page.getByRole('button', { name: 'B.ts', exact: true }).press('Enter');
  assert(await page.evaluate(id => window.harness.messages.some(message => message.type === 'openFile' && message.nodeId === id), nodes[1].id));
  assert.equal(await page.evaluate(() => window.harness.state.view.queryScope.folders[0].path), 'feature');
  await search.fill('');
  const beforeInvalid = await page.evaluate(() => window.harness.messages.filter(message => message.type === 'setView').length);
  await folders.fill('../outside');
  await page.getByRole('button', { name: 'Применить область', exact: true }).click();
  assert.equal(await page.evaluate(() => window.harness.messages.filter(message => message.type === 'setView').length), beforeInvalid, 'Unsafe selectors do not cross the message boundary');
  await folders.fill('.');
  await page.getByLabel('Исключить роль test', { exact: true }).check();
  await page.getByRole('button', { name: 'Применить область', exact: true }).click();
  await page.waitForFunction(() => window.harness.state.view.queryScope?.excludeRoles.includes('test'));
  await page.getByRole('button', { name: 'Сбросить показ (V)', exact: true }).click();
  assert(!(await visibleFiles()).includes(nodes[4].id));
  assert((await visibleFiles()).includes(nodes[1].id));
  await page.getByRole('button', { name: 'Сбросить анализ (Q)', exact: true }).click();
  assert((await visibleFiles()).includes(nodes[4].id), 'Reset restores the previous index without changing legacy test filtering');
  await page.getByLabel('Группировка', { exact: true }).selectOption('folder');
  const folderMark = await page.evaluate(() => document.querySelector('.graph')._cyreg.cy.nodes().filter(node => node.data('group')).map(node => ({ id: node.id(), label: node.data('label'), border: node.data('border') })));
  const feature = folderMark.find(node => node.id === 'group:folder:web/feature');
  assert(feature?.label.includes('задача 2/3'), 'Folder task count includes all indexed members');
  assert.equal(feature.border, undefined, 'Partial folder is not colored as if all children were marked');
  const viewports = [[1440, 1000, 'dark'], [900, 900, 'high-contrast'], [420, 900, 'light']];
  for (const [width, height, theme] of viewports) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => {
      document.body.className = 'vscode-' + theme;
      document.body.style.setProperty('--vscode-editor-background', theme === 'light' ? '#f6f7f9' : '#181e27');
      document.body.style.setProperty('--vscode-editor-foreground', theme === 'light' ? '#18212a' : '#d5dde8');
      document.body.style.setProperty('--vscode-sideBar-background', theme === 'light' ? '#e9edf2' : '#202734');
      document.body.style.setProperty('--vscode-descriptionForeground', theme === 'light' ? '#455568' : '#a5b2c5');
      document.body.style.setProperty('--vscode-input-background', theme === 'light' ? '#fff' : '#151b25');
      document.body.style.setProperty('--vscode-input-foreground', theme === 'light' ? '#18212a' : '#dce6f3');
      document.body.style.setProperty('--vscode-panel-border', theme === 'light' ? '#b5c2d0' : '#344153');
      document.body.style.setProperty('--vscode-contrastBorder', theme === 'high-contrast' ? '#fff' : '');
    }, theme);
    await page.getByRole('button', { name: 'Вписать', exact: true }).click();
    await page.waitForTimeout(180);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No viewport horizontal overflow');
    assert.equal(await page.getByLabel('Цветовая схема', { exact: true }).count(), 1);
    await page.screenshot({ path: `artifacts/ui-web-stack-${width}-${theme}.png` });
  }
  assert.deepEqual(pageErrors, []);
  const result = { checkedAt: new Date().toISOString(), fixtureFiles: nodes.length, checks: ['family-language-task-layers', 'legacy-format-preset', 'V-through-hidden-intermediary', 'strict-Q-Explore', 'global-search-outside-Q', 'unsafe-scope-rejection', 'role-exclusion-reset', 'partial-folder-count'], viewports, pageErrors };
  await writeFile('artifacts/ui-web-stack.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
