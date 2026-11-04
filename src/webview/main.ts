import { emptyGraph, initialView, type FileRef, type GraphNode, type Relation, type ViewState } from '../shared/model';
import type { HostState, HostMessage, UiMessage, SavedUiState } from '../shared/protocol';
import { GraphCanvas, groupProjection, projectGraph, searchGraph, activeBranchContributions, type CanvasSelection, type ProjectedGroup, type ProjectionOptions } from './graph';
import { PanelLayout } from './panels';
import { NodeDepthMenu } from './context-menu';
import { ROLE_LABELS } from '../shared/roles';
import { createGroupControls } from './group-controls';
import { createGraphAppearance, groupFilterIds, type AnnotationGroup, type AnnotationRelation } from './appearance';
import { AnalysisWorkbench, chooseDraftAction } from './analysis-workbench';
import { buildInfo } from '../shared/build-info';
import type { TaskContextData } from '../shared/query-model';
import { inScope, isScopeSpec, normalizeScope, scopeSignature, type ScopeSpec } from '../shared/scope';
import { describeScope } from './scope-description';

declare global { interface Window { __dependencyMapInitialState?: SavedUiState } }
declare function acquireVsCodeApi(): { postMessage(message: UiMessage): void; getState(): SavedUiState | undefined; setState(value: SavedUiState): void };

const api = acquireVsCodeApi();
const saved = api.getState() ?? window.__dependencyMapInitialState ?? {};
let state: HostState = { type: 'state', graph: emptyGraph(), view: initialView(), status: 'Ожидание индекса…', annotations: undefined };
let selected: CanvasSelection = { nodeIds: [], relationIds: [] };
let forcedIds = new Set<string>();
let groups: AnnotationGroup[] = [];
let canvasState = saved.canvas;
let rendering = false;
const collapsedGroupIds = new Set(saved.collapsedGroupIds ?? []);
let visibleGroups: ProjectedGroup[] = [];
let showGroupColors = saved.showGroupColors !== false;
let annotationResult: Extract<HostMessage, { type: 'annotationResult' }> | undefined;
let noteDraft = { key: '', text: '', dirty: false };
let pendingNote: { requestId: string; key: string } | undefined;
let noteSequence = 0;
let panels: PanelLayout;
let workbench: AnalysisWorkbench;
let visibleNodeIds = new Set<string>();
let restoredContextToken = '';
let pendingNoteSave: { requestId: string; resolve(ok: boolean): void; timer: ReturnType<typeof setTimeout> } | undefined;
let draftTransition = false;
let retainedSelectionIds = new Set<string>();
const noteDrafts = new Map<string, typeof noteDraft>();
let canvasSelection: CanvasSelection | undefined;
let canvasSelectionQueued = false;
let relationLimit = 100;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function button(text: string, action: () => void, title = text): HTMLButtonElement {
  const node = element('button', '', text); node.type = 'button'; node.title = title; node.addEventListener('click', action); return node;
}
function label(text: string, control: HTMLElement): HTMLLabelElement {
  if (!control.hasAttribute('aria-label')) control.setAttribute('aria-label', text);
  const node = element('label', 'control'); node.append(element('span', '', text), control); return node;
}
function checkbox(text: string, checked: boolean, change: (value: boolean) => void): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = element('input'); input.type = 'checkbox'; input.checked = checked; input.addEventListener('change', () => change(input.checked));
  const node = element('label', 'check'); node.append(input, document.createTextNode(text)); return { label: node, input };
}
function select(options: [string, string][], change: (value: string) => void): HTMLSelectElement {
  const node = element('select'); for (const [value, text] of options) { const option = element('option', '', text); option.value = value; node.append(option); }
  node.addEventListener('change', () => change(node.value)); return node;
}
function updateView(patch: Partial<ViewState>): void {
  if ('hideExternal' in patch || 'hideTests' in patch) forcedIds.clear();
  const changedMode = patch.mode !== undefined && patch.mode !== state.view.mode;
  state.view = { ...state.view, ...patch }; api.postMessage({ type: 'setView', view: state.view }); render();
  if (changedMode && patch.mode === 'project') canvas.center();
}
function changeFilters(): void { forcedIds.clear(); retainedSelectionIds.clear(); renderProjection(); }
function sameFile(left: FileRef | undefined, right: FileRef | undefined): boolean { return !!left && !!right && left.rootId === right.rootId && left.path === right.path; }
function relationMarked(mark: AnnotationRelation, edge: Relation): boolean {
  const source = state.graph.nodes.find(node => node.id === edge.sourceId);
  const target = state.graph.nodes.find(node => node.id === edge.targetId);
  return sameFile(mark.source, source?.file) && mark.kind === edge.kind && (mark.specifier ?? '') === (edge.specifier ?? '')
    && ('rootId' in mark.target ? sameFile(mark.target, target?.file) : mark.target.packageName === target?.packageName && mark.target.projectId === target?.projectId);
}
function activeGroup(): AnnotationGroup | undefined { return groups.find(group => group.id === state.view.activeGroupId); }
function unavailableMarkCount(): number {
  const fileKey = (file: FileRef) => JSON.stringify([file.rootId, file.path]);
  const endpointKey = (target: AnnotationRelation['target']) => 'rootId' in target ? fileKey(target) : JSON.stringify(['external', target.projectId, target.packageName]);
  const relationKey = (mark: AnnotationRelation) => JSON.stringify([fileKey(mark.source), endpointKey(mark.target), mark.kind, mark.specifier ?? '']);
  const nodeById = new Map(state.graph.nodes.map(node => [node.id, node]));
  const files = new Set(state.graph.nodes.filter(node => node.file).map(node => fileKey(node.file!)));
  const relations = new Set<string>();
  for (const edge of state.graph.relations) {
    const source = nodeById.get(edge.sourceId), target = nodeById.get(edge.targetId);
    if (!source?.file || !target) continue;
    const endpoint = target.file ?? (target.packageName ? { packageName: target.packageName, projectId: target.projectId } : undefined);
    if (endpoint) relations.add(relationKey({ source: source.file, target: endpoint, kind: edge.kind, specifier: edge.specifier }));
  }
  return groups.reduce((count, group) => count + group.files.filter(mark => !files.has(fileKey(mark.file))).length
    + group.relations.filter(mark => !relations.has(relationKey(mark))).length, 0);
}
function annotation(action: string, extras: Partial<Extract<UiMessage, { type: 'annotation' }>> = {}): void {
  api.postMessage({ type: 'annotation', action, groupId: state.view.activeGroupId, nodeIds: selected.nodeIds, relationIds: selected.relationIds, ...extras });
}

const shell = element('main', 'app');
const toolbar = element('section', 'toolbar'); toolbar.setAttribute('aria-label', 'Режим карты');
const mode = select([['file', 'Текущий файл'], ['project', 'Весь проект']], value => { forcedIds.clear(); updateView({ mode: value as ViewState['mode'] }); });
const follow = checkbox('Следовать за редактором', false, value => updateView({ follow: value }));
const depth = select(Array.from({ length: 20 }, (_, i) => [String(i + 1), String(i + 1)]), value => updateView({ depth: Number(value) }));
const grouping = select([['none', 'Без группировки'], ['folder', 'По папкам'], ['project', 'По приложениям']], value => updateView({ groupBy: value as ViewState['groupBy'] }));
const colorPreset = select([['family', 'Цвета семейств'], ['format', 'Цвета форматов']], value => updateView({ colorPreset: value as 'family' | 'format' }));
const resetDepths = button('Сбросить локальные', () => api.postMessage({ type: 'resetNodeDepths' }));
const rebuildButton = button('Пересчитать', () => api.postMessage({ type: 'rebuild' }));
const cancelIndex = button('Остановить индексацию', () => api.postMessage({ type: 'cancel' }));
toolbar.append(label('Режим', mode), follow.label, label('Общая глубина', depth), label('Группировка', grouping), resetDepths, rebuildButton, cancelIndex);
const content = element('div', 'workspace');
const sidebar = element('aside', 'sidebar'); sidebar.setAttribute('aria-label', 'Поиск и фильтры');
const searchInput = element('input'); searchInput.type = 'search'; searchInput.placeholder = 'Файл, путь или импортируемое имя'; searchInput.value = saved.query ?? ''; searchInput.setAttribute('aria-label', 'Поиск по всему индексу');
searchInput.addEventListener('input', () => renderProjection());
const external = checkbox('Внешние пакеты', false, value => updateView({ hideExternal: !value }));
const tests = checkbox('Тестовые файлы и данные (test, mock, fixture)', true, value => updateView({ hideTests: !value }));
const collapsed = checkbox('Свернуть реэкспорты', false, value => updateView({ collapseReexports: value }));
const direction = select([['both', 'В обе стороны'], ['incoming', 'Кто импортирует'], ['outgoing', 'Что импортируется']], changeFilters); direction.value = saved.direction ?? 'both';
const format = select([['', 'Все форматы']], changeFilters);
const project = select([['', 'Все приложения']], changeFilters);
const role = select([['', 'Все роли']], changeFilters);
const folder = element('input'); folder.type = 'text'; folder.value = saved.folder ?? ''; folder.placeholder = 'Например, src/components';
folder.addEventListener('input', changeFilters);
const groupOnly = checkbox('Только активная группа', !!saved.groupOnly, changeFilters);
const resultSummary = element('p', 'small'); resultSummary.setAttribute('aria-live', 'polite');
const results = element('div', 'results'); results.setAttribute('role', 'list'); results.setAttribute('aria-label', 'Файлы карты и результаты поиска');
const groupList = element('div', 'map-groups'); groupList.setAttribute('aria-label', 'Сворачивание областей карты');
const filtersPanel = element('section', 'panel-upper');
const resultsPanel = element('section', 'panel-lower');
filtersPanel.append(label('Поиск во всём проекте', searchInput), element('p', 'hint', 'Поиск включает файлы, скрытые фильтрами.'), label('Направление', direction));
const advancedFilters = element('details', 'advanced-filters'); advancedFilters.append(element('summary', '', 'Фильтры и оформление'),
  label('Формат', format), label('Приложение', project), label('Роль файла', role), label('Папка (от корня)', folder), external.label, tests.label, collapsed.label, groupOnly.label);
filtersPanel.append(advancedFilters);
const scopeControls = element('details', 'scope-controls'); scopeControls.append(element('summary', '', 'Области вида V и анализа Q'));
type ScopeKind = 'queryScope' | 'presentationScope';
let scopeEditorKey = '';
const scopeTarget = select([['queryScope', 'Учитывать при анализе (Q)'], ['presentationScope', 'Показывать на карте (V)']], () => hydrateScopeEditor(true));
const scopeRoot = select([], () => hydrateScopeEditor(true));
const scopePaths = element('textarea'); scopePaths.rows = 2; scopePaths.placeholder = 'src/features/cart\nsrc/shared';
const scopeTests = checkbox('Исключить роль test', false, () => {});
const scopeMocks = checkbox('Исключить роль mock', false, () => {});
const scopeFixtures = checkbox('Исключить роль fixture', false, () => {});
const scopeAdd = checkbox('Добавить папки, сохранив текущие исключения', false, () => {});
const scopeStatus = element('p', 'hint'); scopeStatus.setAttribute('aria-live', 'polite');
function hydrateScopeEditor(force = false): void {
  const scope = state.view[scopeTarget.value as ScopeKind];
  if (!scopeRoot.value) scopeRoot.value = scope?.folders[0]?.rootId ?? state.graph.nodes.find(node => node.file)?.file?.rootId ?? '';
  const key = JSON.stringify([scopeTarget.value, scopeRoot.value, scope]);
  if (!force && key === scopeEditorKey) return;
  scopeEditorKey = key;
  scopePaths.value = scope?.folders.filter(folder => folder.rootId === scopeRoot.value).map(folder => folder.path).join('\n') ?? '.';
  scopeTests.input.checked = scope?.excludeRoles.includes('test') ?? false;
  scopeMocks.input.checked = scope?.excludeRoles.includes('mock') ?? false;
  scopeFixtures.input.checked = scope?.excludeRoles.includes('fixture') ?? false;
  scopeAdd.input.checked = false;
}
function applyScope(kind: ScopeKind): void {
  const previous = state.view[kind];
  const value: ScopeSpec = { version: 1, folders: [...(previous?.folders.filter(folder => folder.rootId !== scopeRoot.value) ?? []), ...scopePaths.value.split(/\r?\n/).map(path => path.trim().replace(/\\/g, '/').replace(/\/$/, '')).filter(Boolean).map(path => ({ rootId: scopeRoot.value, path }))],
    excludeRoles: [scopeTests.input.checked ? 'test' : '', scopeMocks.input.checked ? 'mock' : '', scopeFixtures.input.checked ? 'fixture' : ''].filter(Boolean) };
  if (scopeAdd.input.checked && previous) { value.folders.unshift(...previous.folders); value.excludeRoles.push(...previous.excludeRoles); }
  if (!isScopeSpec(value)) { scopeStatus.textContent = 'Укажите корень и относительные папки, по одной на строку. Точка означает весь корень; выход через .. запрещён.'; return; }
  forcedIds.clear(); retainedSelectionIds.clear(); updateView({ [kind]: normalizeScope(value) });
}
scopeControls.append(element('p', 'hint', 'Показ на карте скрывает файлы визуально. Область анализа ограничивает пути и поиск зависимостей; внешний промежуточный файл не проходит границу. Изменения применяются кнопкой.'),
  label('Редактируемая область', scopeTarget), label('Корень области', scopeRoot), label('Папки (по одной на строку)', scopePaths), scopeTests.label, scopeMocks.label, scopeFixtures.label, scopeAdd.label,
  button('Папка выбранного файла', () => { const node = state.graph.nodes.find(node => selected.nodeIds.includes(node.id) && node.file); if (node?.file) { scopeRoot.value = node.file.rootId; scopePaths.value = node.file.path.includes('/') ? node.file.path.slice(0, node.file.path.lastIndexOf('/')) : '.'; } }),
  button('Применить область', () => applyScope(scopeTarget.value as ScopeKind)),
  button('Сбросить показ (V)', () => updateView({ presentationScope: undefined })), button('Сбросить анализ (Q)', () => updateView({ queryScope: undefined })), scopeStatus);
filtersPanel.append(scopeControls);
advancedFilters.append(label('Цветовая схема', colorPreset), element('p', 'hint', 'Семейства: CODE — код · UI — компоненты/разметка · STYLE — стили · DATA — данные/документы · CFG — конфиги · RES — ресурсы. Язык указан в подписи, задача — отдельной отметкой.'));
resultsPanel.append(groupList, resultSummary, results, element('p', 'hint', 'Enter — открыть, пробел — выбрать, Shift+F10 — глубина узла.'));

const stage = element('section', 'stage'); stage.setAttribute('aria-label', 'Граф зависимостей');
const stageToolbar = element('div', 'stage-toolbar');
const graphSummary = element('span', 'small');
const focusSummary = element('p', 'focus-summary'); focusSummary.setAttribute('role', 'status');
const canvasElement = element('div', 'graph'); canvasElement.setAttribute('aria-label', 'Визуальный граф. Для клавиатуры используйте список файлов слева.');
const empty = element('div', 'empty');
const legend = element('div', 'legend', 'Стрелка: импортирующий → импортируемый · Пунктир: предположение · ×N: свёрнутая цепочка/группа связей · Двойной клик по области: свернуть/раскрыть · Ctrl/⌘: несколько элементов');
const expandDepth = button('Общая глубина +1', () => updateView({ depth: Math.min(20, state.view.depth + 1) }));
stageToolbar.append(button('−', () => canvas.zoomBy(1 / 1.25), 'Уменьшить масштаб'), button('+', () => canvas.zoomBy(1.25), 'Увеличить масштаб'),
  button('Вписать', () => canvas.center()), button('Раскладка', () => canvas.layout(state.view.mode)), expandDepth, graphSummary);
stage.append(stageToolbar, focusSummary, canvasElement, empty, legend);

const inspector = element('aside', 'inspector'); inspector.setAttribute('aria-label', 'Детали и группы задач');
const tasksPanel = element('section', 'panel-lower tasks-panel'); tasksPanel.tabIndex = -1;
const detailsPanel = element('section', 'panel-upper details-panel'); detailsPanel.tabIndex = -1;
const groupControls = createGroupControls({ activateGroup: id => { void resolveDrafts().then(ok => { if (ok) updateView({ activeGroupId: id }); else renderDetails(); }); }, command: command => api.postMessage({ type: 'annotation', ...command }) });
const selectionSummary = element('p', 'small');
const showColors = checkbox('Показывать цвета задач', showGroupColors, value => { showGroupColors = value; renderProjection(); persist(); });
const note = element('textarea'); note.rows = 3; note.maxLength = 10000; note.placeholder = 'Заметка к выбранному файлу или связи';
note.addEventListener('input', () => { noteDraft.text = note.value; noteDraft.dirty = true; updateNoteFeedback(); });
const saveNote = button('Сохранить заметку', () => {
  if (pendingNote) return;
  const requestId = `note-${Date.now().toString(36)}-${++noteSequence}`;
  pendingNote = { requestId, key: noteDraft.key }; saveNote.disabled = true; updateNoteFeedback();
  annotation('note', { note: noteDraft.text, requestId });
});
const noteHint = element('p', 'hint');
noteHint.setAttribute('role', 'status');
const recoverNotes = button('Несохранённые заметки', () => {
  const dialog = element('dialog', 'review-dialog'); dialog.setAttribute('aria-label', 'Сохранённые черновики заметок');
  dialog.append(element('h2', '', 'Черновики к недоступным элементам'), element('p', 'hint', 'Текст сохранён в этой вкладке. Вернитесь к элементу для сохранения или скопируйте его перед закрытием.'));
  for (const draft of noteDrafts.values()) if (draft.dirty) { const text = element('textarea'); text.readOnly = true; text.rows = 4; text.value = draft.text; text.setAttribute('aria-label', 'Текст несохранённой заметки'); dialog.append(text); }
  dialog.append(button('Закрыть', () => dialog.close())); dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
});
const groupError = element('p', 'error'); groupError.setAttribute('role', 'alert');
const groupAvailability = element('p', 'hint'); groupAvailability.setAttribute('aria-live', 'polite');
const details = element('section', 'details'); details.setAttribute('aria-live', 'polite');
const problems = element('details', 'problems'); const problemSummary = element('summary', '', 'Диагностика'); const problemList = element('div'); problems.append(problemSummary, problemList);
tasksPanel.append(groupControls.element, showColors.label, selectionSummary, label('Заметка', note), saveNote, noteHint, recoverNotes, groupError, groupAvailability);
detailsPanel.append(details, problems);
const status = element('footer', 'status'); status.setAttribute('role', 'status');
shell.append(toolbar, content, status); document.body.append(shell);
panels = new PanelLayout(shell, content, saved.panelSizes, persist);
sidebar.append(filtersPanel, panels.handles.leftTop, resultsPanel); inspector.append(detailsPanel, panels.handles.rightTop, tasksPanel);
panels.handles.rightTop.setAttribute('aria-label', 'Высота деталей');
content.append(sidebar, panels.handles.left, stage, panels.handles.right, inspector, panels.handles.narrowCanvas);
content.dataset.pane = 'list';
const paneNavigation = element('nav', 'pane-navigation'); paneNavigation.setAttribute('aria-label', 'Разделы узкой карты');
for (const [pane, text] of [['list', 'Поиск'], ['details', 'Детали'], ['task', 'Задача']] as const) {
  const control = button(text, () => showPane(pane, true)); control.dataset.pane = pane; control.setAttribute('aria-pressed', String(pane === 'list')); paneNavigation.append(control);
}
stage.append(paneNavigation);
function showPane(pane: 'list' | 'details' | 'task', focus = false): void {
  content.dataset.pane = pane;
  paneNavigation.querySelectorAll<HTMLButtonElement>('button').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.pane === pane)));
  if (focus && window.matchMedia('(max-width: 759px)').matches) {
    const target = pane === 'list' ? searchInput : pane === 'details' ? detailsPanel : tasksPanel;
    target.focus({ preventScroll: true });
  }
}
shell.insertBefore(panels.handles.toolbar, content);
const depthMenu = new NodeDepthMenu((nodeId, value) => api.postMessage({ type: 'setNodeDepth', nodeId, depth: value }),
  (nodeId, direction, action) => api.postMessage({ type: 'branch', nodeId, direction, action }));
document.body.append(depthMenu.element);

const canvas = new GraphCanvas(canvasElement, {
  open: nodeId => { void changeSelection({ nodeIds: [nodeId], relationIds: [] }, () => api.postMessage({ type: 'openFile', nodeId })); },
  toggleGroup,
  context: (nodeId, point) => openDepthMenu(nodeId, point),
  selection: value => {
    if (rendering) return;
    canvasSelection = value;
    if (canvasSelectionQueued) return;
    canvasSelectionQueued = true;
    queueMicrotask(() => { canvasSelectionQueued = false; const next = canvasSelection; canvasSelection = undefined; if (next) void changeSelection(next); });
  },
  save: value => { canvasState = value; persist(); }
}, saved.canvas);
workbench = new AnalysisWorkbench({
  send: message => api.postMessage(message),
  reveal: (nodeIds, relationIds = []) => {
    void changeSelection({ nodeIds: nodeIds.slice(0, 500), relationIds }, () => {
      for (const id of nodeIds) forcedIds.add(id);
      renderProjection();
    });
  },
  select: nodeId => {
    void changeSelection({ nodeIds: [nodeId], relationIds: [] });
  },
  contextData, beforeRestore: resolveDrafts
});
const narrowQuery = window.matchMedia('(max-width: 759px)');
function placeQuerySummary(): void {
  if (narrowQuery.matches) workbench.element.insertBefore(workbench.summary, workbench.element.children[1] ?? null);
  else stage.insertBefore(workbench.summary, canvasElement);
}
narrowQuery.addEventListener('change', placeQuerySummary); placeQuerySummary();
detailsPanel.insertBefore(workbench.element, details);
tasksPanel.append(workbench.tasks);
problems.append(workbench.diagnostics);
function openDepthMenu(nodeId: string, point?: { x: number; y: number }, opener?: HTMLElement): void {
  const node = state.graph.nodes.find(item => item.id === nodeId);
  if (!node || node.kind !== 'file') return;
  depthMenu.open(node.id, node.file?.path ?? node.label, state.view.nodeDepths?.[node.id], point, opener, state.view.mode === 'file', direction.value === 'both',
    !!state.analytics?.runtime.compatible && state.analytics.index.state === 'ready' && (state.view.mode === 'file' || !!state.analytics.active));
}

function localUiState(): SavedUiState {
  return { canvas: canvasState, query: searchInput.value, format: format.value, project: project.value, role: role.value, folder: folder.value, direction: direction.value, groupOnly: groupOnly.input.checked, collapsedGroupIds: [...collapsedGroupIds], panelSizes: panels?.state(), showGroupColors };
}
function persist(): void {
  const next = localUiState();
  api.setState(next);
  api.postMessage({ type: 'saveLocalState', state: next, contextToken: state.analytics?.uiStateToken });
}
function contextData(): TaskContextData {
  canvasState = canvas.state();
  return { view: { ...state.view }, ui: localUiState(), query: state.analytics?.active?.query,
    branches: (state.analytics?.branches ?? []).map(({ result, ...branch }) => branch), selection: { nodeIds: [...selected.nodeIds], relationIds: [...selected.relationIds] } };
}
async function resolveDrafts(): Promise<boolean> {
  if (draftTransition || pendingNote) return false;
  if (!groupControls.hasDraft() && !noteDraft.dirty) return true;
  draftTransition = true;
  try {
    const choice = await chooseDraftAction();
    if (choice === 'stay') return false;
    if (choice === 'discard') { groupControls.discardDraft(); noteDrafts.delete(noteDraft.key); noteDraft.dirty = false; return true; }
    if (!await groupControls.saveDraft()) return false;
    if (!noteDraft.dirty) return true;
    if (saveNote.disabled) { noteHint.textContent = 'Заметку нельзя сохранить: сначала пометьте выбранный элемент. Переход отменён.'; return false; }
    return await new Promise<boolean>(resolve => {
      saveNote.click();
      if (!pendingNote) { resolve(false); return; }
      const requestId = pendingNote.requestId;
      pendingNoteSave = { requestId, resolve, timer: setTimeout(() => { if (pendingNoteSave?.requestId === requestId) { pendingNoteSave = undefined; resolve(false); } }, 15000) };
    });
  } finally { draftTransition = false; }
}
function selectCanvas(): void {
  const previous = rendering; rendering = true; canvas.select(selected.nodeIds, selected.relationIds); rendering = previous;
}
async function changeSelection(next: CanvasSelection, after?: () => void): Promise<void> {
  const key = (selection: CanvasSelection) => JSON.stringify([[...selection.nodeIds].sort(), [...selection.relationIds].sort()]);
  if (key(next) !== key(selected)) {
    selectCanvas();
    if (!await resolveDrafts()) { selectCanvas(); renderDetails(); return; }
    selected = next; relationLimit = 100;
  }
  after?.(); selectCanvas(); renderDetails();
  if (next.nodeIds.length || next.relationIds.length) showPane('details');
}
function updateNoteFeedback(): void {
  const unavailable = [...noteDrafts.values()].filter(draft => draft.dirty && draft.key !== noteDraft.key).length;
  recoverNotes.hidden = unavailable === 0;
  recoverNotes.textContent = `Несохранённые заметки (${unavailable})`;
  noteHint.textContent = pendingNote ? 'Сохранение заметки…' : noteDraft.dirty ? 'Заметка не сохранена.'
    : saveNote.disabled ? noteHint.dataset.unavailable ?? 'Для заметки выберите помеченный элемент группы.' : 'Заметка сохранена.';
  if (unavailable) noteHint.textContent += ' Черновик к другому элементу сохранён в этой вкладке.';
}
function restoreLocalContext(data: TaskContextData): void {
  const ui = data.ui;
  searchInput.value = ui.query ?? ''; format.value = ui.format ?? ''; project.value = ui.project ?? ''; role.value = ui.role ?? ''; folder.value = ui.folder ?? ''; direction.value = ui.direction ?? 'both';
  groupOnly.input.checked = !!ui.groupOnly; showGroupColors = ui.showGroupColors !== false; showColors.input.checked = showGroupColors;
  collapsedGroupIds.clear(); for (const id of ui.collapsedGroupIds ?? []) collapsedGroupIds.add(id);
  selected = { nodeIds: [...data.selection.nodeIds], relationIds: [...data.selection.relationIds] };
  forcedIds.clear(); panels.restore(ui.panelSizes); canvasState = ui.canvas; canvas.restore(ui.canvas); noteDraft.dirty = false;
}
function applyPendingRestore(): void {
  const restore = state.analytics?.taskContexts.restore;
  if (restore && restore.token !== restoredContextToken) { restoredContextToken = restore.token; restoreLocalContext(restore.data); }
}
function toggleGroup(groupId: string): void {
  const group = visibleGroups.find(item => item.id === groupId);
  if (!group) return;
  if (group.collapsed) collapsedGroupIds.delete(groupId);
  else { collapsedGroupIds.add(groupId); for (const nodeId of group.memberIds) forcedIds.delete(nodeId); }
  renderProjection();
}
function updateOptions(control: HTMLSelectElement, values: string[], allLabel: string, restored?: string, labels?: Map<string, string>): void {
  const current = control.dataset.optionsReady ? control.value : control.value || restored || '';
  if (values.length) control.dataset.optionsReady = 'true';
  const options = [['', allLabel], ...values.sort((left, right) => (labels?.get(left) ?? left).localeCompare(labels?.get(right) ?? right)).map(value => [value, labels?.get(value) ?? value])];
  if (control.options.length !== options.length || Array.from(control.options).some((option, index) => option.value !== options[index][0] || option.textContent !== options[index][1])) {
    control.replaceChildren(...options.map(([value, text]) => { const option = element('option', '', text); option.value = value; return option; }));
  }
  control.value = values.includes(current) ? current : '';
}
function render(): void {
  groups = parseGroups(state.annotations);
  cancelIndex.disabled = state.analytics?.index.state !== 'building';
  cancelIndex.title = cancelIndex.disabled ? 'Сейчас индексация не выполняется.' : 'Остановить построение индекса; существующая карта останется с отметкой об устаревании.';
  rebuildButton.title = state.analytics?.index.state === 'building' ? 'Перезапустить построение индекса' : 'Обновить индекс файлов и зависимостей';
  mode.value = state.view.mode; follow.input.checked = state.view.follow;
  depth.value = String(state.view.depth); if (!depth.value) { const option = element('option', '', String(state.view.depth)); option.value = String(state.view.depth); depth.append(option); depth.value = option.value; }
  depth.disabled = expandDepth.disabled = state.view.mode === 'project';
  depth.title = state.view.mode === 'project' ? 'В режиме проекта видны все доступные файлы; глубина применяется в режиме файла.' : 'Общий радиус от текущего файла';
  const localCount = Object.keys(state.view.nodeDepths ?? {}).length;
  resetDepths.textContent = `Сбросить локальные (${localCount})`; resetDepths.disabled = localCount === 0;
  grouping.value = state.view.groupBy; external.input.checked = !state.view.hideExternal; tests.input.checked = !state.view.hideTests; collapsed.input.checked = state.view.collapseReexports;
  colorPreset.value = state.view.colorPreset ?? 'family';
  updateOptions(scopeRoot, [...new Set(state.graph.nodes.flatMap(node => node.file ? [node.file.rootId] : []))], 'Выберите корень', undefined,
    new Map(state.graph.nodes.flatMap(node => node.file ? [[node.file.rootId, node.projectName ?? 'Корень проекта'] as [string, string]] : [])));
  hydrateScopeEditor();
  scopeStatus.textContent = `Показ (V): ${describeScope(state.view.presentationScope, state.graph.nodes)} · Анализ (Q): ${describeScope(state.view.queryScope, state.graph.nodes)}`;
  updateOptions(format, [...new Set(state.graph.nodes.map(node => node.format))], 'Все форматы', saved.format);
  updateOptions(project, [...new Set(state.graph.nodes.map(node => node.projectId))], 'Все приложения', saved.project,
    new Map(state.graph.nodes.map(node => [node.projectId, node.projectName ?? node.projectId])));
  updateOptions(role, [...new Set(state.graph.nodes.map(node => node.role).filter((value): value is string => !!value))], 'Все роли', saved.role,
    new Map(Object.entries(ROLE_LABELS)));
  renderStatus();
  groupError.textContent = state.annotationError ?? '';
  const unavailable = state.graph.revision > 0 ? unavailableMarkCount() : 0;
  groupAvailability.textContent = unavailable ? `Недоступных пометок: ${unavailable}. Они сохранены и могут снова стать доступны после смены ветки или обновления индекса.` : '';
  renderProjection(); renderDetails();
}
function renderStatus(): void {
  const indexLabels: Record<string, string> = { empty: 'Нет индекса', building: 'Индексация', ready: 'Индекс актуален', stale: 'Индекс устарел', failed: 'Ошибка индекса', cancelled: 'Индексация остановлена' };
  const focused = state.graph.nodes.find(node => node.id === state.view.focusId);
  focusSummary.textContent = state.view.mode === 'project' ? 'Обзор проекта. Выбор файла открывает детали.' : `В центре: ${focused?.file?.path ?? 'файл не выбран'} · ${state.view.follow ? 'следование за редактором включено' : 'центр закреплён'}`;
  status.textContent = `${state.analytics ? `v${state.analytics.runtime.host.extensionVersion} · ${indexLabels[state.analytics.index.state]} · ` : ''}${state.status} · ${state.graph.stats.files} файлов · ${state.graph.stats.relations} связей · ревизия ${state.graph.revision} · Анализ: ${describeScope(state.view.queryScope, state.graph.nodes)}`;
  status.title = status.textContent;
}
function editScope(kind: ScopeKind): void {
  scopeControls.open = true; scopeTarget.value = kind; hydrateScopeEditor(true); showPane('list', true); scopeTarget.focus({ preventScroll: true }); scopeControls.scrollIntoView({ block: 'nearest' });
}
function renderProjection(): void {
  const group = activeGroup();
  const marks = group ? groupFilterIds(state.graph, group) : undefined;
  const active = state.analytics?.active;
  const proposedAnswer = active?.result?.operation === 'success' ? active.result : active?.previousResult;
  const answer = proposedAnswer && (proposedAnswer.queryScopeSignature ?? 'all') === scopeSignature(state.view.queryScope) ? proposedAnswer : undefined;
  retainedSelectionIds = new Set([...retainedSelectionIds].filter(id => selected.nodeIds.includes(id)));
  const revealed = new Set([...forcedIds, ...retainedSelectionIds]);
  const options: ProjectionOptions = { forcedIds: revealed, markedIds: groupOnly.input.checked ? (marks ?? new Set()) : undefined,
    format: format.value, project: project.value, role: role.value, folder: folder.value, direction: direction.value as 'both' | 'incoming' | 'outgoing',
    queryNodeIds: answer ? new Set(answer.nodeIds) : undefined,
    queryRelationIds: answer ? new Set(answer.relationIds) : undefined };
  const base = projectGraph(state.graph, state.view, options);
  const contributions = activeBranchContributions(new Set(base.nodes.map(n => n.id)), (state.analytics?.branches ?? []).filter(branch => branch.result?.freshness === 'current'
    && (branch.result.queryScopeSignature ?? 'all') === scopeSignature(state.view.queryScope)));
  const projection = contributions.nodeIds.size ? projectGraph(state.graph, state.view, { ...options, branchNodeIds: contributions.nodeIds, branchRelationIds: contributions.relationIds }) : base;
  if ((state.analytics?.active || contributions.nodeIds.size) && projection.nodes.length > 500) {
    const keep = new Set([...new Set([...selected.nodeIds, ...forcedIds, ...projection.nodes.map(n => n.id)])].slice(0, 500));
    projection.nodes = projection.nodes.filter(n => keep.has(n.id)); projection.edges = projection.edges.filter(e => keep.has(e.sourceId) && keep.has(e.targetId));
  }
  const matching = searchGraph(state.graph, searchInput.value);
  const grouped = groupProjection(projection, state.view.groupBy, collapsedGroupIds, revealed);
  visibleGroups = grouped.groups;
  const appearance = createGraphAppearance(state.graph, group, grouped.groups, showGroupColors, state.view.colorPreset ?? 'family');
  rendering = true;
  canvas.render(grouped, state.view, appearance, new Set(matching.map(node => node.id)), !!state.analytics?.active);
  canvas.select(selected.nodeIds, selected.relationIds);
  rendering = false;
  const visible = new Set(grouped.nodes.map(node => node.id));
  visibleNodeIds = visible;
  workbench?.update(state, selected, visible);
  const nodes = searchInput.value.trim() ? matching : projection.nodes;
  const collapsedCount = grouped.groups.filter(item => item.collapsed).length;
  graphSummary.textContent = `${grouped.nodes.length} файлов${collapsedCount ? ` + ${collapsedCount} областей` : ''} · ${grouped.edges.length} связей${retainedSelectionIds.size ? ` · сохранено выбранных: ${retainedSelectionIds.size}` : ''}`;
  resultSummary.textContent = searchInput.value.trim() ? `Найдено ${nodes.length} во всём индексе` : `На карте ${nodes.length} файлов и пакетов`;
  results.replaceChildren();
  groupList.replaceChildren();
  if (grouped.groups.length) {
    groupList.append(element('h3', '', 'Области карты'));
    for (const item of grouped.groups) {
      const toggle = button(`${item.collapsed ? '▸' : '▾'} ${item.label} (${item.memberIds.length})`, () => toggleGroup(item.id), `${item.collapsed ? 'Раскрыть' : 'Свернуть'} ${item.label}`);
      toggle.className = 'group-toggle'; toggle.setAttribute('aria-expanded', String(!item.collapsed)); toggle.dataset.groupId = item.id; groupList.append(toggle);
    }
  }
  for (const node of nodes.slice(0, 300)) {
    const row = element('div', 'file-row'); row.setAttribute('role', 'listitem');
    const choose = button(node.label, () => { void changeSelection({ nodeIds: [node.id], relationIds: [] }, () => {
      if (!visible.has(node.id) && inScope(node, state.view.queryScope)) { forcedIds.add(node.id); renderProjection(); }
      canvas.center(node.id);
    }); }, `${node.file?.path ?? node.packageName ?? node.label} · ${node.projectName ?? node.projectId}`);
    choose.className = 'file-choice'; choose.dataset.nodeId = node.id; choose.setAttribute('aria-pressed', String(selected.nodeIds.includes(node.id)));
    choose.addEventListener('keydown', event => {
      if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') { event.preventDefault(); openDepthMenu(node.id, undefined, choose); }
      if (event.key === 'Enter' && node.kind === 'file') { event.preventDefault(); api.postMessage({ type: 'openFile', nodeId: node.id }); }
    });
    choose.addEventListener('contextmenu', event => { event.preventDefault(); openDepthMenu(node.id, { x: event.clientX, y: event.clientY }, choose); });
    const badges = groups.filter(item => item.files.some(mark => sameFile(mark.file, node.file))).map(item => item.name);
    const outside = !inScope(node, state.view.queryScope);
    const path = element('span', 'file-path', `${node.file?.path ?? node.packageName ?? 'Внешний пакет'}${outside ? ' · вне Q: предпросмотр, Enter — открыть' : !visible.has(node.id) ? ' · скрыт видом — показать' : ''}${badges.length ? ` · ${badges.join(', ')}` : ''}`);
    row.append(choose, path); results.append(row);
  }
  if (nodes.length > 300) results.append(element('p', 'hint', 'Показаны первые 300 результатов. Уточните поиск; индекс содержит все результаты.'));
  empty.hidden = grouped.nodes.length + collapsedCount > 0;
  const scopedFiles = state.graph.nodes.filter(node => node.file && inScope(node, state.view.queryScope));
  const emptyMessage = state.graph.nodes.length === 0 ? state.analytics?.index.state === 'building' ? 'Индекс строится. Файлы появятся после анализа.' : 'Нет доступных файлов в индексе. Откройте папку проекта или пересчитайте индекс.'
    : state.view.mode === 'file' && !state.view.focusId ? 'Откройте карту из файла или найдите файл слева и выберите «В центр карты».'
      : state.view.queryScope && !scopedFiles.length ? 'В области анализа нет доступных файлов. Проверьте папки и исключённые роли.'
        : state.view.presentationScope && !scopedFiles.some(node => inScope(node, state.view.presentationScope)) ? 'Области показа и анализа не пересекаются. Измените одну из областей.'
      : state.view.mode === 'file' && state.view.focusId && !inScope(state.graph.nodes.find(node => node.id === state.view.focusId), state.view.queryScope) ? 'Фокус вне области анализа. Откройте файл из поиска или явно измените область анализа.'
        : 'Нет узлов с такими фильтрами. Поиск слева работает по всему проекту.';
  empty.replaceChildren(element('p', '', emptyMessage));
  if (!empty.hidden) {
    const actions = element('div', 'actions');
    if (!state.graph.nodes.length && state.analytics?.index.state !== 'building') actions.append(button('Пересчитать индекс', () => api.postMessage({ type: 'rebuild' })));
    else if (state.view.queryScope && !scopedFiles.length || state.view.mode === 'file' && state.view.focusId && !inScope(state.graph.nodes.find(node => node.id === state.view.focusId), state.view.queryScope)) actions.append(button('Изменить область анализа', () => editScope('queryScope')));
    else if (state.view.presentationScope && !scopedFiles.some(node => inScope(node, state.view.presentationScope))) actions.append(button('Изменить показ на карте', () => editScope('presentationScope')), button('Изменить область анализа', () => editScope('queryScope')));
    else if (state.graph.nodes.length) actions.append(button('Очистить фильтры показа', () => { searchInput.value = format.value = project.value = role.value = folder.value = ''; groupOnly.input.checked = false; direction.value = 'both'; changeFilters(); }));
    empty.append(actions);
  }
  persist();
}
function renderDetails(): void {
  if ([...retainedSelectionIds].some(id => !selected.nodeIds.includes(id))) { retainedSelectionIds = new Set([...retainedSelectionIds].filter(id => selected.nodeIds.includes(id))); renderProjection(); }
  const hasSelection = selected.nodeIds.length + selected.relationIds.length > 0;
  const group = activeGroup();
  const canMark = !!group && hasSelection;
  const allMarked = selected.nodeIds.every(id => group?.files.some(mark => sameFile(mark.file, state.graph.nodes.find(node => node.id === id)?.file)))
    && selected.relationIds.every(id => { const edge = state.graph.relations.find(edge => edge.id === id); return !!edge && group?.relations.some(mark => relationMarked(mark, edge)); });
  saveNote.disabled = !canMark || !allMarked || !!pendingNote;
  noteHint.dataset.unavailable = canMark && !allMarked ? 'Для заметки сначала добавьте выбранные элементы в группу.' : 'Для заметки выберите помеченный элемент группы.';
  note.disabled = !!pendingNote;
  groupControls.update({ groups, activeGroupId: state.view.activeGroupId,
    selection: { nodeIds: selected.nodeIds.filter(id => state.graph.nodes.some(node => node.id === id && node.kind === 'file')), relationIds: selected.relationIds },
    error: state.annotationError, result: annotationResult });
  selectionSummary.textContent = `Выбрано: файлов ${selected.nodeIds.length}, связей ${selected.relationIds.length}`;
  details.replaceChildren(element('h2', '', 'Детали'));
  const node = state.graph.nodes.find(item => item.id === selected.nodeIds[0]);
  const edge = state.graph.relations.find(item => item.id === selected.relationIds[0]);
  let currentNote = '';
  if (node) {
    details.append(element('h3', '', node.label), element('p', 'path', node.file ? `${node.projectName ?? node.projectId}/${node.file.path}` : node.packageName ?? node.label),
      element('p', 'small', `${node.kind === 'external' ? 'Внешний узел' : node.format} · ${node.role ? ROLE_LABELS[node.role as keyof typeof ROLE_LABELS] ?? node.role : 'файл'} · ${node.projectName ?? node.projectId}`));
    if (node.roleReason) details.append(element('p', 'hint', node.roleReason));
    const actions = element('div', 'actions');
    actions.append(button('В центр карты', () => { forcedIds.clear(); updateView({ mode: 'file', focusId: node.id }); canvas.center(node.id); }),
      button('Открыть файл', () => api.postMessage({ type: 'openFile', nodeId: node.id })));
    if (node.kind === 'external') (actions.lastChild as HTMLButtonElement).disabled = true;
    details.append(actions);
    if (node.kind === 'file') {
      details.append(workbench.fileActions(node));
      const localDepth = state.view.nodeDepths?.[node.id];
      const depthAction = button(localDepth === undefined ? 'Индивидуальная глубина…' : `Глубина для узла: ${localDepth}`, () => openDepthMenu(node.id));
      depthAction.disabled = state.view.mode === 'project';
      depthAction.title = state.view.mode === 'project' ? 'В режиме проекта глубина не ограничивает карту. Перейдите в режим файла.' : 'Радиус от выбранного узла дополняет общую область';
      details.append(depthAction);
    }
    currentNote = activeGroup()?.files.find(mark => sameFile(mark.file, node.file))?.note ?? '';
    const outgoing = state.graph.relations.filter(item => item.sourceId === node.id);
    const incoming = state.graph.relations.filter(item => item.targetId === node.id);
    details.append(element('h3', '', `Импортирует / ссылается (${outgoing.length})`));
    appendRelations(outgoing, 'targetId');
    details.append(element('h3', '', `Входящие связи (${incoming.length})`)); appendRelations(incoming, 'sourceId');
    const unresolved = state.graph.unresolved.filter(item => item.sourceId === node.id);
    if (unresolved.length) {
      details.append(element('h3', '', `Не разрешено (${unresolved.length})`));
      for (const ref of unresolved) details.append(element('p', 'unresolved', `${ref.expression ?? ''}${ref.expression ? ' — ' : ''}${ref.reason}`));
    }
  }
  if (edge) {
    const source = state.graph.nodes.find(item => item.id === edge.sourceId);
    const target = state.graph.nodes.find(item => item.id === edge.targetId);
    details.append(element('h3', '', `${source?.label ?? '?'} → ${target?.label ?? '?'}`), element('p', '', `${edge.kind} · ${edge.certainty === 'confirmed' ? 'подтверждено' : 'предполагается'}`),
      element('p', 'path', edge.specifier ?? ''), element('p', '', edge.bindings.map(binding => `${binding.typeOnly ? 'type ' : ''}${binding.imported}${binding.local && binding.local !== binding.imported ? ` as ${binding.local}` : ''}`).join(', ') || 'Связь без импортированных имён'));
    for (const item of edge.evidence) details.append(element('p', 'hint', `${item.rule}${item.range ? ` · строка ${item.range.start.line + 1}` : ''}`));
    details.append(button('Перейти к обращению', () => api.postMessage({ type: 'openEvidence', relationId: edge.id })));
    details.append(workbench.bindingActions(edge));
    for (const imported of new Set(edge.bindings.map(binding => binding.imported))) {
      if (imported === '*') continue;
      const declaration = state.graph.declarations?.find(item => item.relationId === edge.id && item.imported === imported);
      if (declaration) details.append(button(`Объявление: ${imported}`, () => api.postMessage({ type: 'openDeclaration', relationId: edge.id, imported }),
        `${declaration.file.path} · строка ${declaration.range.start.line + 1}`));
    }
    currentNote = activeGroup()?.relations.find(mark => relationMarked(mark, edge))?.note ?? '';
    if (selected.relationIds.length > 1) details.append(element('p', 'hint', `Выбрана цепочка из ${selected.relationIds.length} фактических связей. Пометка применяется к ним, не к виртуальной стрелке.`));
  }
  if (!hasSelection) details.append(element('p', 'hint', 'Выберите файл или стрелку. Для нескольких элементов используйте Ctrl/⌘ или выделение рамкой.'));
  const noteKey = JSON.stringify([state.view.activeGroupId, [...selected.nodeIds].sort(), [...selected.relationIds].sort()]);
  if (noteDraft.key !== noteKey) {
    if (noteDraft.dirty) noteDrafts.set(noteDraft.key, noteDraft);
    noteDraft = noteDrafts.get(noteKey) ?? { key: noteKey, text: currentNote, dirty: false };
  }
  else if (!noteDraft.dirty && !pendingNote) noteDraft.text = currentNote;
  if (note.value !== noteDraft.text) note.value = noteDraft.text;
  updateNoteFeedback();
  results.querySelectorAll<HTMLButtonElement>('.file-choice').forEach(control => control.setAttribute('aria-pressed', String(selected.nodeIds.includes(control.dataset.nodeId ?? ''))));
  const diagnostics = state.graph.diagnostics;
  problemSummary.textContent = `Диагностика (${diagnostics.length}) · неразрешённых обращений ${state.graph.unresolved.length}`;
  problemList.replaceChildren();
  for (const item of diagnostics.slice(0, 100)) {
    const source = state.graph.nodes.find(node => node.id === item.fileId);
    problemList.append(element('p', 'hint', `${source?.file?.path ? `${source.file.path}: ` : ''}${item.message}`));
  }
  if (diagnostics.length > 100) problemList.append(element('p', 'hint', 'Показаны первые 100 диагностик.'));
  workbench?.update(state, selected, visibleNodeIds);
}
function appendRelations(edges: Relation[], endpoint: 'sourceId' | 'targetId'): void {
  for (const edge of edges.slice(0, relationLimit)) {
    const node = state.graph.nodes.find(item => item.id === edge[endpoint]);
    const row = button(`${node?.label ?? edge[endpoint]} · ${edge.kind}${edge.certainty === 'inferred' ? ' · ?' : ''}`, () => {
      void changeSelection({ nodeIds: [], relationIds: [edge.id] });
    }, node?.file?.path ?? edge.specifier ?? 'Показать связь');
    row.className = 'relation-choice'; details.append(row);
  }
  if (edges.length > relationLimit) details.append(button(`Показать ещё связи (${Math.min(100, edges.length - relationLimit)})`, () => { relationLimit += 100; renderDetails(); }));
}
function parseGroups(value: unknown): AnnotationGroup[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { groups?: unknown }).groups)) return [];
  return ((value as { groups: unknown[] }).groups).filter((item): item is AnnotationGroup => !!item && typeof item === 'object'
    && typeof (item as AnnotationGroup).id === 'string' && typeof (item as AnnotationGroup).name === 'string' && typeof (item as AnnotationGroup).color === 'string'
    && Array.isArray((item as AnnotationGroup).files) && Array.isArray((item as AnnotationGroup).relations));
}

window.addEventListener('message', event => {
  const message = event.data as HostMessage;
  if (message?.type === 'annotationResult') {
    annotationResult = message;
    if (pendingNote?.requestId === message.requestId) {
      if (message.ok) { noteDrafts.delete(pendingNote.key); if (pendingNote.key === noteDraft.key) noteDraft.dirty = false; }
      pendingNote = undefined;
    }
    if (pendingNoteSave?.requestId === message.requestId) { clearTimeout(pendingNoteSave.timer); pendingNoteSave.resolve(message.ok); pendingNoteSave = undefined; }
    renderDetails(); return;
  }
  if (message?.type === 'status') {
    if (typeof message.status !== 'string' || !Number.isInteger(message.revision)
      || message.revision < state.graph.revision && (!message.analytics || message.analytics.index.version.epoch === state.analytics?.index.version.epoch)) return;
    state.status = message.status; if (message.analytics) { retainSelectionOnCollapse(message.analytics); state.analytics = message.analytics; applyPendingRestore(); render(); } else renderStatus(); return;
  }
  if (message?.type === 'diagnostics') { workbench.showDiagnostics(message.text); return; }
  if (message?.type !== 'state' || !message.graph || !message.view || !Array.isArray(message.graph.nodes)) return;
  if (message.graph.revision < state.graph.revision && (!message.analytics || message.analytics.index.version.epoch === state.analytics?.index.version.epoch)) return;
  if (message.analytics) retainSelectionOnCollapse(message.analytics);
  state = message;
  applyPendingRestore();
  const nodeIds = new Set(state.graph.nodes.map(node => node.id));
  const edgeIds = new Set(state.graph.relations.map(edge => edge.id));
  selected.nodeIds = selected.nodeIds.filter(id => nodeIds.has(id)); selected.relationIds = selected.relationIds.filter(id => edgeIds.has(id));
  forcedIds = new Set([...forcedIds].filter(id => nodeIds.has(id)));
  render();
});
function retainSelectionOnCollapse(next: NonNullable<HostState['analytics']>): void {
  const previous = state.analytics;
  if (!previous || previous.index.version.epoch !== next.index.version.epoch || previous.active?.requestId !== next.active?.requestId) { retainedSelectionIds.clear(); return; }
  if (previous.branches.some(b => !next.branches.some(n => n.id === b.id))) for (const id of selected.nodeIds) if (visibleNodeIds.has(id)) retainedSelectionIds.add(id);
}
window.addEventListener('pagehide', () => { narrowQuery.removeEventListener('change', placeQuerySummary); canvasState = canvas.state(); persist(); canvas.destroy(); panels.destroy(); groupControls.destroy(); depthMenu.destroy(); });
render();
api.postMessage({ type: 'ready', build: buildInfo });
