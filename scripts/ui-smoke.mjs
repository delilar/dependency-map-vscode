import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const paths = ['src/pages/Profile.tsx', 'src/hooks/useProfile.ts', 'src/stores/profile.ts', 'src/components/Avatar.tsx',
  'public/avatar.svg', 'src/pages/Routes.tsx', 'src/components/index.ts', 'src/types/profile.d.ts'];
const fixture = {
  type: 'state', graph: {
    revision: 1,
    nodes: paths.map((path, index) => ({ id: `n${index}`, label: path.split('/').pop(), kind: 'file',
      projectId: 'project:internal-fixture-id', projectName: 'demo-app', format: `.${path.split('.').pop()}`, role: path.endsWith('.d.ts') ? 'type' : undefined, file: { rootId: 'app', path } })),
    relations: [[0, 1, 'import'], [0, 6, 'import'], [6, 3, 'reexport'], [1, 2, 'import'], [3, 4, 'resource'], [5, 0, 'import']]
      .map(([source, target, kind], index) => ({ id: `e${index}`, sourceId: `n${source}`, targetId: `n${target}`, kind,
        certainty: 'confirmed', specifier: `./${paths[target].split('/').pop()}`,
        bindings: [{ imported: index === 0 ? 'useProfile' : paths[target].split('/').pop().split('.')[0], typeOnly: false }],
        evidence: [{ rule: kind === 'reexport' ? 'export from' : 'ES import', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 30 } } }] })),
    declarations: [{ relationId: 'e0', imported: 'useProfile', file: { rootId: 'app', path: paths[1] }, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } } }],
    unresolved: [{ sourceId: 'n0', expression: 'import(dynamicPath)', reason: 'Вычисляемая цель не определена статически', evidence: { rule: 'dynamic import' } }],
    diagnostics: [], stats: { files: paths.length, relations: 6, elapsedMs: 12 }
  },
  view: { mode: 'file', focusId: 'n0', follow: false, depth: 1, hideExternal: true, hideTests: false, groupBy: 'none', collapseReexports: false, activeGroupId: 'profile-task' },
  status: 'Индекс актуален',
  annotations: { version: 1, roots: [{ id: 'app', label: 'demo-app' }], groups: [
    { id: 'profile-task', name: 'Переделка профиля', color: '#eab308', files: [
      { file: { rootId: 'app', path: paths[0] }, note: 'Проверить загрузку профиля' },
      { file: { rootId: 'app', path: 'src/removed/Old.tsx' }, note: 'Сохранить для другой ветки' }
    ], relations: [{ source: { rootId: 'app', path: paths[0] }, target: { rootId: 'app', path: 'src/removed/Old.tsx' }, kind: 'import', specifier: './Old' }] }
  ] }
};
const init = `
const current = ${JSON.stringify(fixture)};
window.__current = current;window.__failNext=false;
window.__messages = [];
window.__dependencyMapInitialState = {query:'Profile',canvas:{zoom:1.25,pan:{x:12,y:8},...(location.search.includes('cameraOnly')?{}:{positions:{n0:{x:32,y:64}}})}};
let saved;
window.acquireVsCodeApi = () => ({
  getState: () => saved,
  setState: value => { saved = value; window.__savedState = value; },
  postMessage: message => {
    window.__messages.push(message);
    if (message.type === 'setView') current.view = message.view;
    if(message.type==='setNodeDepth'){current.view.nodeDepths??={};if(message.depth===null)delete current.view.nodeDepths[message.nodeId];else current.view.nodeDepths[message.nodeId]=message.depth;}
    if(message.type==='resetNodeDepths')current.view.nodeDepths={};
    if(message.type==='annotation'&&window.__failNext){window.__failNext=false;current.annotationError='Тестовая ошибка записи';setTimeout(()=>{window.postMessage(current,'*');window.postMessage({type:'annotationResult',requestId:message.requestId,ok:false,action:message.action,files:0,relations:0,skipped:0,message:'Тестовая ошибка записи'},'*');},0);return;}
    if(message.type==='annotation')current.annotationError=undefined;
    if (message.type === 'annotation' && ['createGroup','createGroupAndMark'].includes(message.action)) {
      const id='new-task-'+current.annotations.groups.length;
      current.annotations.groups.push({id,name:message.name,color:message.color,files:[],relations:[]});
      current.view.activeGroupId = id;message.groupId=id;
    }
    if(message.type==='annotation'&&message.action==='updateGroup'){const group=current.annotations.groups.find(item=>item.id===message.groupId);if(group){group.name=message.name;group.color=message.color;}}
    if (message.type === 'annotation' && ['mark','createGroupAndMark'].includes(message.action)) {
      const group = current.annotations.groups.find(item=>item.id===message.groupId);
      if(group) for(const id of message.nodeIds ?? []) { const node=current.graph.nodes.find(item=>item.id===id); if(node?.file) group.files.push({file:node.file}); }
      if(group)for(const id of message.relationIds??[]){const relation=current.graph.relations.find(item=>item.id===id);const source=current.graph.nodes.find(item=>item.id===relation?.sourceId);const target=current.graph.nodes.find(item=>item.id===relation?.targetId);if(source?.file&&target?.file)group.relations.push({source:source.file,target:target.file,kind:relation.kind,specifier:relation.specifier});}
    }
    if (message.type === 'annotation' && message.action === 'note') {
      const group=current.annotations.groups.find(item=>item.id===message.groupId);
      if(group) for(const id of message.nodeIds ?? []) { const node=current.graph.nodes.find(item=>item.id===id); const mark=group.files.find(item=>item.file.path===node?.file?.path); if(mark) mark.note=message.note; }
    }
    if (['ready','setView','annotation','setNodeDepth','resetNodeDepths'].includes(message.type)) setTimeout(()=>{window.postMessage(current,'*');if(message.type==='annotation'&&message.requestId)window.postMessage({type:'annotationResult',requestId:message.requestId,ok:true,action:message.action,groupId:message.groupId,files:message.nodeIds?.length??0,relations:message.relationIds?.length??0,skipped:0,message:'Изменения сохранены'},'*');},message.type==='ready'?450:0);
  }
});`;
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-ui-smoke'; img-src 'self' data:">
<link rel="stylesheet" href="/styles.css"></head><body class="vscode-dark" style="--vscode-editor-background:#181e27;--vscode-editor-foreground:#d5dde8;--vscode-sideBar-background:#202734;--vscode-descriptionForeground:#a5b2c5;--vscode-input-background:#151b25;--vscode-input-foreground:#dce6f3;--vscode-button-secondaryBackground:#344354;--vscode-button-background:#5689c9;--vscode-font-family:Segoe UI;--vscode-font-size:13px;--vscode-panel-border:#344153;--vscode-focusBorder:#6da9ff"><script nonce="ui-smoke">${init}</script><script nonce="ui-smoke" src="/webview.js"></script></body></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/' || request.url?.startsWith('/?')) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
    const file = request.url === '/webview.js' ? ['dist/webview.js', 'text/javascript']
      : request.url === '/styles.css' ? ['dist/styles.css', 'text/css'] : undefined;
    if (!file) { response.writeHead(404); response.end(); return; }
    const body = await readFile(file[0]); response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); response.end(body);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
let browser;
try {
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByLabel('Режим', { exact: true }).waitFor();
  await page.locator('.advanced-filters > summary').click();
  assert.equal(await page.locator('.topbar').count(), 0, 'Redundant brand header is removed');
  await page.getByRole('button', { name: 'Profile.tsx', exact: true }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__savedState.canvas?.zoom), 1.25, 'Startup with an empty index followed by a graph must retain the restored zoom');
  assert.deepEqual(await page.evaluate(() => window.__savedState.canvas?.pan), { x: 12, y: 8 }, 'Startup must retain the restored pan');
  const search = page.getByRole('searchbox', { name: 'Поиск по всему индексу' });
  assert.equal(await search.inputValue(), 'Profile', 'A recreated Webview should restore the host-injected local state');
  await search.fill('avatar.svg');
  await page.getByRole('button', { name: 'avatar.svg', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click();
  assert(await page.evaluate(() => window.__messages.some(item => item.type === 'openFile' && item.nodeId === 'n4')), 'Hidden search result should open the correct node');
  assert(await page.evaluate(() => window.__messages.some(item => item.type === 'saveLocalState' && item.state.query === 'avatar.svg')), 'Local UI state should also reach the host workspace storage');
  await search.fill('useProfile');
  assert.equal(await page.locator('.file-choice').count(), 2, 'Imported symbol search should find source and target');
  await search.fill('');
  await page.getByLabel('Следовать за редактором', { exact: true }).check();
  assert(await page.evaluate(() => window.__messages.some(item => item.type === 'setView' && item.view.follow)), 'Following should update host state');
  await page.getByLabel('Режим', { exact: true }).selectOption('project');
  await page.getByLabel('Формат', { exact: true }).selectOption('.svg');
  await page.waitForFunction(() => document.querySelectorAll('.file-choice').length === 1);
  await page.getByLabel('Формат', { exact: true }).selectOption('');
  await page.getByLabel('Роль файла', { exact: true }).selectOption('type');
  await page.waitForFunction(() => document.querySelectorAll('.file-choice').length === 1);
  assert.equal(await page.locator('.file-choice').textContent(), 'profile.d.ts', 'Role filter should use the declared file role');
  await page.getByLabel('Роль файла', { exact: true }).selectOption('');
  await page.getByLabel('Папка (от корня)', { exact: true }).fill('src/types');
  await page.waitForFunction(() => document.querySelectorAll('.file-choice').length === 1);
  await page.getByLabel('Папка (от корня)', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Profile.tsx', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert(await page.evaluate(() => window.__messages.some(item => item.type === 'openFile' && item.nodeId === 'n0')), 'Keyboard Enter should open a file from the DOM list');
  await page.getByRole('button', { name: 'Profile.tsx', exact: true }).click();
  assert(await page.getByText('Недоступных пометок: 2. Они сохранены и могут снова стать доступны после смены ветки или обновления индекса.', { exact: true }).isVisible(), 'Missing file and relation marks should be explained without deleting them');
  assert(await page.getByRole('button', { name: 'Добавить выбранное в группу', exact: true }).isEnabled(), 'Missing marks must not block editing valid selected files');
  await page.waitForFunction(() => {
    const camera = JSON.stringify(window.__savedState.canvas);
    if (window.__settledCamera !== camera) { window.__settledCamera = camera; window.__cameraChangedAt = performance.now(); }
    return performance.now() - window.__cameraChangedAt > 400;
  });
  const beforeStatus = await page.evaluate(() => {
    window.__statusProbeFirst = document.querySelector('.file-choice');
    return { camera: window.__savedState.canvas, query: document.querySelector('input[type=search]').value,
      selection: document.querySelector('.group-selection p.small')?.textContent,
      saves: window.__messages.filter(item => item.type === 'saveLocalState').length };
  });
  await page.evaluate(() => { for (let index = 0; index < 20; index++) window.postMessage({ type: 'status', status: `Progress ${index}`, revision: 1 }, '*'); });
  await page.waitForFunction(() => document.querySelector('.status')?.textContent?.startsWith('Progress 19'));
  assert(await page.evaluate(() => document.querySelector('.file-choice') === window.__statusProbeFirst), 'Progress-only updates must not rebuild the results or graph projection');
  assert.deepEqual(await page.evaluate(() => ({ camera: window.__savedState.canvas, query: document.querySelector('input[type=search]').value,
    selection: document.querySelector('.group-selection p.small')?.textContent, saves: window.__messages.filter(item => item.type === 'saveLocalState').length })), beforeStatus, 'Progress updates must preserve the camera, query, selection and local persistence state');
  assert.equal(await page.getByLabel('Приложение', { exact: true }).locator('option[value="project:internal-fixture-id"]').textContent(), 'demo-app', 'Application selector should show a human name while keeping its internal ID');
  assert((await page.locator('.details').textContent()).includes('demo-app/src/pages/Profile.tsx'), 'File details should display the project name and relative path');
  assert(!(await page.locator('.details').textContent()).includes('project:internal-fixture-id'), 'Internal project IDs should not leak into file details');
  await page.getByRole('button', { name: 'useProfile.ts · import', exact: true }).click();
  await page.getByRole('button', { name: 'Объявление: useProfile', exact: true }).click();
  assert(await page.evaluate(() => window.__messages.some(item => item.type === 'openDeclaration' && item.relationId === 'e0' && item.imported === 'useProfile')), 'Resolved binding should navigate via relation and imported name, not a client URI');
  await page.getByRole('button', { name: 'Profile.tsx', exact: true }).click();
  await page.getByLabel('Активная группа', { exact: true }).selectOption('');
  await page.getByLabel('Название группы', { exact: true }).fill('Проверка smoke');
  assert.equal(await page.locator('input[type=color]').count(), 0, 'Palette does not use the OS color chooser');
  await page.getByRole('button', { name: 'Выбрать цвет группы', exact: true }).click();
  await page.getByLabel('HEX цвета', { exact: true }).fill('#60a5fa');
  await page.getByLabel('Название группы', { exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Выбор цвета', exact: true }).count(), 0, 'Escape closes the palette');
  assert(await page.getByRole('button', { name: 'Выбрать цвет группы', exact: true }).evaluate(node=>node===document.activeElement));
  await page.getByRole('button', { name: 'Выбрать цвет группы', exact: true }).click();
  await page.getByLabel('HEX цвета', { exact: true }).fill('#60a5fa');
  await page.evaluate(()=>window.postMessage(window.__current,'*'));
  assert.equal(await page.getByLabel('HEX цвета', { exact: true }).inputValue(), '#60a5fa', 'Host updates preserve the palette candidate');
  await page.getByRole('button', { name: 'Выбрать цвет', exact: true }).click();
  await page.getByRole('button', { name: 'Создать пустую группу', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select') && window.__messages.some(item => item.type === 'annotation' && item.action === 'createGroup' && item.name === 'Проверка smoke'));
  await page.getByText('Для заметки сначала добавьте выбранные элементы в группу.', { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Сохранить заметку', exact: true }).isDisabled(), 'An unmarked selection cannot silently discard a note');
  await page.getByRole('button', { name: 'Добавить выбранное в группу', exact: true }).click();
  await page.getByLabel('Название группы', { exact: true }).fill('Проверка smoke retry');
  await page.evaluate(()=>window.__failNext=true);
  await page.getByRole('button', { name: 'Сохранить свойства группы', exact: true }).click();
  await page.getByText('Тестовая ошибка записи',{exact:true}).first().waitFor();
  assert.equal(await page.getByLabel('Название группы', { exact: true }).inputValue(), 'Проверка smoke retry');
  assert(await page.getByRole('button', { name: 'Сохранить свойства группы', exact: true }).isEnabled(), 'Failed properties save remains retryable');
  await page.getByRole('button', { name: 'Сохранить свойства группы', exact: true }).click();
  await page.getByLabel('Заметка', { exact: true }).fill('Проверить профиль перед изменением API');
  await page.evaluate(()=>window.postMessage(window.__current,'*'));
  assert.equal(await page.getByLabel('Заметка', { exact: true }).inputValue(), 'Проверить профиль перед изменением API', 'Host snapshots preserve an unsaved note draft');
  await page.evaluate(()=>window.__failNext=true);
  await page.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
  await page.getByText('Тестовая ошибка записи',{exact:true}).first().waitFor();
  assert.equal(await page.getByLabel('Заметка', { exact: true }).inputValue(), 'Проверить профиль перед изменением API', 'Failed notes keep their draft after the save button takes focus');
  assert(await page.getByRole('button', { name: 'Сохранить заметку', exact: true }).isEnabled(), 'Failed note saves remain retryable');
  await page.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
  assert(await page.evaluate(() => window.__messages.some(item => item.type === 'annotation' && item.action === 'note' && item.nodeIds.includes('n0') && item.note.includes('API'))), 'Selected file note should reach host');
  await page.getByLabel('Режим', { exact: true }).selectOption('file');
  await page.getByRole('button', { name: 'useProfile.ts', exact: true }).focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('dialog', { name: 'Индивидуальная глубина узла', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert(await page.getByRole('button', { name: 'useProfile.ts', exact: true }).evaluate(node=>node===document.activeElement), 'Escape restores the list keyboard focus');
  await page.keyboard.press('Shift+F10');
  await page.getByLabel('Индивидуальная глубина', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Применить глубину', exact: true }).click();
  await page.waitForFunction(()=>window.__messages.some(item=>item.type==='setNodeDepth'&&item.nodeId==='n1'&&item.depth===2));
  await page.getByRole('button', { name: 'profile.ts', exact: true }).waitFor();
  await page.getByRole('button', { name: /Сбросить локальные/ }).click();
  assert(await page.evaluate(()=>window.__messages.some(item=>item.type==='resetNodeDepths')));
  await page.getByRole('button', { name: 'Profile.tsx', exact: true }).click({ button: 'right' });
  await page.getByRole('dialog', { name: 'Индивидуальная глубина узла', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Режим', { exact: true }).selectOption('project');
  await page.getByRole('button', { name: 'Profile.tsx', exact: true }).focus();
  await page.keyboard.press('Shift+F10');
  assert(await page.getByLabel('Индивидуальная глубина', { exact: true }).isDisabled(), 'Project view explains why local depth does not limit the graph');
  await page.keyboard.press('Escape');
  await page.getByLabel('Свернуть реэкспорты', { exact: true }).check();
  assert.equal(await page.getByRole('button', { name: 'index.ts', exact: true }).count(), 0, 'Collapsed barrel should not appear as a normal node');
  await page.getByLabel('Свернуть реэкспорты', { exact: true }).uncheck();
  await page.getByLabel('Группировка', { exact: true }).selectOption('project');
  await page.getByRole('button', { name: 'Раскладка', exact: true }).click();
  const projectToggle = page.locator('.group-toggle').first();
  await projectToggle.click();
  assert.equal(await projectToggle.getAttribute('aria-expanded'), 'false', 'Project group should collapse to an aggregate node');
  assert(await page.evaluate(() => window.__savedState.collapsedGroupIds.includes('group:project:project:internal-fixture-id')), 'Collapsed group IDs should persist in local Webview state');
  await page.getByRole('button', { name: 'Вписать', exact: true }).click();
  await page.waitForTimeout(250);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/ui-smoke-collapsed.png', fullPage: true });
  const openedBeforeToggle = await page.evaluate(() => window.__messages.filter(item => item.type === 'openFile').length);
  const graphBounds = await page.locator('.graph').boundingBox();
  await page.mouse.dblclick(graphBounds.x + graphBounds.width / 2, graphBounds.y + graphBounds.height / 2);
  await page.waitForFunction(() => document.querySelector('.group-toggle')?.getAttribute('aria-expanded') === 'true');
  assert.equal(await page.evaluate(() => window.__messages.filter(item => item.type === 'openFile').length), openedBeforeToggle, 'A synthetic group must toggle without opening a file');
  await page.locator('.group-toggle').first().click();
  await search.fill('avatar.svg');
  await page.getByRole('button', { name: 'avatar.svg', exact: true }).click();
  assert.equal(await page.locator('.group-toggle').first().getAttribute('aria-expanded'), 'true', 'Search reveal should expand the containing application');
  await search.fill('');
  await page.locator('.group-toggle').first().click();
  assert.equal(await page.locator('.group-toggle').first().getAttribute('aria-expanded'), 'false');
  await page.locator('.group-toggle').first().click();
  assert.equal(await page.locator('.group-toggle').first().getAttribute('aria-expanded'), 'true');
  await page.getByLabel('Группировка', { exact: true }).selectOption('folder');
  await page.locator('.group-toggle').first().click();
  assert.equal(await page.locator('.group-toggle').first().getAttribute('aria-expanded'), 'false', 'Folder group should collapse independently');
  await page.locator('.group-toggle').first().click();
  await page.getByLabel('Группировка', { exact: true }).selectOption('none');
  await page.getByRole('button', { name: 'Раскладка', exact: true }).click();
  await page.getByRole('button', { name: 'Profile.tsx', exact: true }).click();
  await page.getByRole('button', { name: 'Вписать', exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('canvas').count() > 0, true, 'Cytoscape canvas should be mounted');
  assert.deepEqual(errors, [], 'UI should render without uncaught exceptions');
  await page.evaluate(()=>document.querySelectorAll('.panel-upper').forEach(panel=>panel.scrollTop=0));
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/ui-smoke.png', fullPage: true });
  await page.evaluate(() => { document.body.className = 'vscode-high-contrast'; document.body.style.setProperty('--vscode-contrastBorder', '#ffffff'); });
  await page.screenshot({ path: 'artifacts/ui-smoke-high-contrast.png', fullPage: true });
  await page.evaluate(() => { document.body.className = 'vscode-light'; document.body.style.setProperty('--vscode-editor-background', '#ffffff'); document.body.style.setProperty('--vscode-editor-foreground', '#1f2937'); document.body.style.setProperty('--vscode-sideBar-background', '#f2f5f9'); document.body.style.setProperty('--vscode-descriptionForeground', '#495768'); document.body.style.setProperty('--vscode-input-background', '#ffffff'); document.body.style.setProperty('--vscode-input-foreground', '#1f2937'); document.body.style.setProperty('--vscode-panel-border', '#ccd5df'); document.body.style.setProperty('--vscode-textLink-foreground', '#006ab1'); });
  await page.screenshot({ path: 'artifacts/ui-smoke-light.png', fullPage: true });
  await page.setViewportSize({ width: 860, height: 900 });
  await page.getByRole('button', { name: 'Вписать', exact: true }).click();
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Beside editor width should not require horizontal scrolling');
  assert(await page.locator('.graph').evaluate(node => node.getBoundingClientRect().width >= 250), 'Narrow editor should retain a usable graph area');
  await page.screenshot({ path: 'artifacts/ui-smoke-narrow.png', fullPage: true });
  const leftHandle = page.getByRole('separator', { name: 'Ширина поиска и фильтров', exact: true });
  const initialLeft = (await page.locator('.sidebar').boundingBox()).width;
  await leftHandle.focus(); await page.keyboard.press('ArrowRight');
  assert((await page.locator('.sidebar').boundingBox()).width >= initialLeft + 9, 'Keyboard separator resizes the sidebar');
  const leftBounds = await leftHandle.boundingBox();
  await page.mouse.move(leftBounds.x + leftBounds.width / 2, leftBounds.y + 30);
  await page.mouse.down(); await page.mouse.move(leftBounds.x + 30, leftBounds.y + 30, { steps: 5 }); await page.mouse.up();
  const preferences = await page.evaluate(()=>window.__savedState.panelSizes);
  assert(preferences.leftWidth > initialLeft + 10, 'Pointer drag commits the preferred panel width');
  await page.getByRole('separator', { name: 'Высота панели управления', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('separator', { name: 'Высота деталей', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  for (const viewport of [{width:640,height:900},{width:420,height:300},{width:860,height:300}]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(100);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), `No horizontal overflow at ${viewport.width}x${viewport.height}`);
    assert((await page.locator('.graph').boundingBox()).height>30, 'The graph remains available in a low-height pane');
    if (viewport.width < 760) await page.getByRole('button', { name: 'Поиск', exact: true }).click();
    await page.getByRole('button', { name: 'Profile.tsx', exact: true }).focus(); await page.keyboard.press('Shift+F10');
    const menuBounds = await page.getByRole('dialog', { name: 'Индивидуальная глубина узла', exact: true }).boundingBox();
    assert(menuBounds.x>=0&&menuBounds.y>=0&&menuBounds.x+menuBounds.width<=viewport.width&&menuBounds.y+menuBounds.height<=viewport.height,'Context dialog stays inside the viewport');
    await page.keyboard.press('Escape');
    const currentPreferences = await page.evaluate(()=>window.__savedState.panelSizes);
    assert.equal(currentPreferences.leftWidth, preferences.leftWidth, 'Responsive clamping does not overwrite desktop width preferences');
  }
  await page.screenshot({ path:'artifacts/ui-smoke-low-height.png',fullPage:true });
  const restored = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  for (let run = 0; run < 2; run++) {
    if (run === 0) await restored.goto(`http://127.0.0.1:${address.port}/?cameraOnly=1`); else await restored.reload();
    await restored.getByRole('button', { name: 'Profile.tsx', exact: true }).waitFor();
    await restored.waitForTimeout(500);
    assert.equal(await restored.evaluate(() => window.__savedState.canvas?.zoom), 1.25, 'Camera-only restore must not be overwritten by initial layout or reload');
    assert.deepEqual(await restored.evaluate(() => window.__savedState.canvas?.pan), { x: 12, y: 8 });
  }
  await restored.close();
  assert.deepEqual(errors, [], 'Expanded controls, context menus and resizing do not introduce browser errors');
  console.log('UI smoke passed: canvas, hidden-result search, imports, navigation, filters, follow, groups, notes, reexports, grouping, themes.');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
