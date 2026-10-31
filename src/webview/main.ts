import { emptyGraph, initialView, type FileRef, type GraphNode, type Relation, type ViewState } from '../shared/model';
import type { HostState, HostMessage, UiMessage, SavedUiState } from '../shared/protocol';
import { GraphCanvas, groupProjection, projectGraph, searchGraph, type CanvasSelection, type ProjectedGroup } from './graph';
import { PanelLayout } from './panels';
import { NodeDepthMenu } from './context-menu';
import { ROLE_LABELS } from '../shared/roles';
import { createGroupControls } from './group-controls';
import { createGraphAppearance, groupFilterIds, type AnnotationGroup, type AnnotationRelation } from './appearance';

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
function changeFilters(): void { forcedIds.clear(); renderProjection(); }
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
const resetDepths = button('Сбросить локальные', () => api.postMessage({ type: 'resetNodeDepths' }));
toolbar.append(label('Режим', mode), follow.label, label('Общая глубина', depth), label('Группировка', grouping), resetDepths,
  button('Пересчитать', () => api.postMessage({ type: 'rebuild' })), button('Отмена', () => api.postMessage({ type: 'cancel' })));
const content = element('div', 'workspace');
const sidebar = element('aside', 'sidebar'); sidebar.setAttribute('aria-label', 'Поиск и фильтры');
const searchInput = element('input'); searchInput.type = 'search'; searchInput.placeholder = 'Файл, путь или импортируемое имя'; searchInput.value = saved.query ?? ''; searchInput.setAttribute('aria-label', 'Поиск по всему индексу');
searchInput.addEventListener('input', () => renderProjection());
const external = checkbox('Внешние пакеты', false, value => updateView({ hideExternal: !value }));
const tests = checkbox('Тесты и fixtures', true, value => updateView({ hideTests: !value }));
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
filtersPanel.append(label('Поиск во всём проекте', searchInput), element('p', 'hint', 'Поиск включает файлы, скрытые фильтрами.'),
  label('Направление', direction), label('Формат', format), label('Приложение', project), label('Роль файла', role), label('Папка (от корня)', folder), external.label, tests.label, collapsed.label,
  groupOnly.label);
resultsPanel.append(groupList, resultSummary, results, element('p', 'hint', 'Enter — открыть, пробел — выбрать, Shift+F10 — глубина узла.'));

const stage = element('section', 'stage'); stage.setAttribute('aria-label', 'Граф зависимостей');
const stageToolbar = element('div', 'stage-toolbar');
const graphSummary = element('span', 'small');
const canvasElement = element('div', 'graph'); canvasElement.setAttribute('aria-label', 'Визуальный граф. Для клавиатуры используйте список файлов слева.');
const empty = element('div', 'empty');
const legend = element('div', 'legend', 'Стрелка: импортирующий → импортируемый · Пунктир: предположение или свёрнутая связь · Двойной клик по области: свернуть/раскрыть · Ctrl/⌘: несколько элементов');
const expandDepth = button('Общая глубина +1', () => updateView({ depth: Math.min(20, state.view.depth + 1) }));
stageToolbar.append(button('−', () => canvas.zoomBy(1 / 1.25), 'Уменьшить масштаб'), button('+', () => canvas.zoomBy(1.25), 'Увеличить масштаб'),
  button('Вписать', () => canvas.center()), button('Раскладка', () => canvas.layout(state.view.mode)), expandDepth, graphSummary);
stage.append(stageToolbar, canvasElement, empty, legend);

const inspector = element('aside', 'inspector'); inspector.setAttribute('aria-label', 'Детали и группы задач');
const tasksPanel = element('section', 'panel-upper');
const detailsPanel = element('section', 'panel-lower');
const groupControls = createGroupControls({ activateGroup: id => updateView({ activeGroupId: id }), command: command => api.postMessage({ type: 'annotation', ...command }) });
const selectionSummary = element('p', 'small');
const showColors = checkbox('Показывать цвета задач', showGroupColors, value => { showGroupColors = value; renderProjection(); persist(); });
const note = element('textarea'); note.rows = 3; note.maxLength = 10000; note.placeholder = 'Заметка к выбранному файлу или связи';
note.addEventListener('input', () => { noteDraft.text = note.value; noteDraft.dirty = true; });
const saveNote = button('Сохранить заметку', () => {
  if (pendingNote) return;
  const requestId = `note-${Date.now().toString(36)}-${++noteSequence}`;
  pendingNote = { requestId, key: noteDraft.key }; saveNote.disabled = true;
  annotation('note', { note: noteDraft.text, requestId });
});
const noteHint = element('p', 'hint');
const groupError = element('p', 'error'); groupError.setAttribute('role', 'alert');
const groupAvailability = element('p', 'hint'); groupAvailability.setAttribute('aria-live', 'polite');
const details = element('section', 'details'); details.setAttribute('aria-live', 'polite');
const problems = element('details', 'problems'); const problemSummary = element('summary', '', 'Диагностика'); const problemList = element('div'); problems.append(problemSummary, problemList);
tasksPanel.append(groupControls.element, showColors.label, selectionSummary, label('Заметка', note), saveNote, noteHint, groupError, groupAvailability);
detailsPanel.append(details, problems);
const status = element('footer', 'status'); status.setAttribute('role', 'status');
shell.append(toolbar, content, status); document.body.append(shell);
panels = new PanelLayout(shell, content, saved.panelSizes, persist);
sidebar.append(filtersPanel, panels.handles.leftTop, resultsPanel); inspector.append(tasksPanel, panels.handles.rightTop, detailsPanel);
content.append(sidebar, panels.handles.left, stage, panels.handles.right, inspector, panels.handles.narrowCanvas);
shell.insertBefore(panels.handles.toolbar, content);
const depthMenu = new NodeDepthMenu((nodeId, value) => api.postMessage({ type: 'setNodeDepth', nodeId, depth: value }));
document.body.append(depthMenu.element);

const canvas = new GraphCanvas(canvasElement, {
  open: nodeId => api.postMessage({ type: 'openFile', nodeId }),
  toggleGroup,
  context: (nodeId, point) => openDepthMenu(nodeId, point),
  selection: value => { if (rendering) return; selected = value; renderDetails(); },
  save: value => { canvasState = value; persist(); }
}, saved.canvas);
function openDepthMenu(nodeId: string, point?: { x: number; y: number }, opener?: HTMLElement): void {
  const node = state.graph.nodes.find(item => item.id === nodeId);
  if (!node || node.kind !== 'file') return;
  depthMenu.open(node.id, node.file?.path ?? node.label, state.view.nodeDepths?.[node.id], point, opener, state.view.mode === 'file', direction.value === 'both');
}

function persist(): void {
  const next: SavedUiState = { canvas: canvasState, query: searchInput.value, format: format.value, project: project.value, role: role.value, folder: folder.value, direction: direction.value, groupOnly: groupOnly.input.checked, collapsedGroupIds: [...collapsedGroupIds], panelSizes: panels?.state(), showGroupColors };
  api.setState(next);
  api.postMessage({ type: 'saveLocalState', state: next });
}
function toggleGroup(groupId: string): void {
  const group = visibleGroups.find(item => item.id === groupId);
  if (!group) return;
  if (group.collapsed) collapsedGroupIds.delete(groupId);
  else { collapsedGroupIds.add(groupId); for (const nodeId of group.memberIds) forcedIds.delete(nodeId); }
  renderProjection();
}
function updateOptions(control: HTMLSelectElement, values: string[], allLabel: string, restored?: string, labels?: Map<string, string>): void {
  const current = control.value || restored || '';
  const options = [['', allLabel], ...values.sort((left, right) => (labels?.get(left) ?? left).localeCompare(labels?.get(right) ?? right)).map(value => [value, labels?.get(value) ?? value])];
  if (control.options.length !== options.length || Array.from(control.options).some((option, index) => option.value !== options[index][0] || option.textContent !== options[index][1])) {
    control.replaceChildren(...options.map(([value, text]) => { const option = element('option', '', text); option.value = value; return option; }));
  }
  control.value = values.includes(current) ? current : '';
}
function render(): void {
  groups = parseGroups(state.annotations);
  mode.value = state.view.mode; follow.input.checked = state.view.follow;
  depth.value = String(state.view.depth); if (!depth.value) { const option = element('option', '', String(state.view.depth)); option.value = String(state.view.depth); depth.append(option); depth.value = option.value; }
  depth.disabled = expandDepth.disabled = state.view.mode === 'project';
  depth.title = state.view.mode === 'project' ? 'В режиме проекта видны все доступные файлы; глубина применяется в режиме файла.' : 'Общий радиус от текущего файла';
  const localCount = Object.keys(state.view.nodeDepths ?? {}).length;
  resetDepths.textContent = `Сбросить локальные (${localCount})`; resetDepths.disabled = localCount === 0;
  grouping.value = state.view.groupBy; external.input.checked = !state.view.hideExternal; tests.input.checked = !state.view.hideTests; collapsed.input.checked = state.view.collapseReexports;
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
  status.textContent = `${state.status} · ${state.graph.stats.files} файлов · ${state.graph.stats.relations} связей · ревизия ${state.graph.revision}`;
}
function renderProjection(): void {
  const group = activeGroup();
  const marks = group ? groupFilterIds(state.graph, group) : undefined;
  const projection = projectGraph(state.graph, state.view, { forcedIds, markedIds: groupOnly.input.checked ? (marks ?? new Set()) : undefined,
    format: format.value, project: project.value, role: role.value, folder: folder.value, direction: direction.value as 'both' | 'incoming' | 'outgoing' });
  const matching = searchGraph(state.graph, searchInput.value);
  const grouped = groupProjection(projection, state.view.groupBy, collapsedGroupIds, forcedIds);
  visibleGroups = grouped.groups;
  const appearance = createGraphAppearance(state.graph, group, grouped.groups, showGroupColors);
  rendering = true;
  canvas.render(grouped, state.view, appearance, new Set(matching.map(node => node.id)));
  canvas.select(selected.nodeIds, selected.relationIds);
  rendering = false;
  const visible = new Set(grouped.nodes.map(node => node.id));
  const nodes = searchInput.value.trim() ? matching : projection.nodes;
  const collapsedCount = grouped.groups.filter(item => item.collapsed).length;
  graphSummary.textContent = `${grouped.nodes.length} файлов${collapsedCount ? ` + ${collapsedCount} областей` : ''} · ${grouped.edges.length} связей`;
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
    const choose = button(node.label, () => {
      selected = { nodeIds: [node.id], relationIds: [] };
      if (!visible.has(node.id)) { forcedIds.add(node.id); renderProjection(); }
      canvas.select([node.id]); canvas.center(node.id); renderDetails();
    }, `${node.file?.path ?? node.packageName ?? node.label} · ${node.projectName ?? node.projectId}`);
    choose.className = 'file-choice';
    choose.addEventListener('keydown', event => {
      if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') { event.preventDefault(); openDepthMenu(node.id, undefined, choose); }
      if (event.key === 'Enter' && node.kind === 'file') { event.preventDefault(); api.postMessage({ type: 'openFile', nodeId: node.id }); }
    });
    choose.addEventListener('contextmenu', event => { event.preventDefault(); openDepthMenu(node.id, { x: event.clientX, y: event.clientY }, choose); });
    const badges = groups.filter(item => item.files.some(mark => sameFile(mark.file, node.file))).map(item => item.name);
    const path = element('span', 'file-path', `${node.file?.path ?? node.packageName ?? 'Внешний пакет'}${!visible.has(node.id) ? ' · скрыт — показать' : ''}${badges.length ? ` · ${badges.join(', ')}` : ''}`);
    row.append(choose, path); results.append(row);
  }
  if (nodes.length > 300) results.append(element('p', 'hint', 'Показаны первые 300 результатов. Уточните поиск; индекс содержит все результаты.'));
  empty.hidden = grouped.nodes.length + collapsedCount > 0;
  empty.textContent = state.graph.nodes.length === 0 ? 'Индекс строится или проект не содержит доступных файлов.'
    : state.view.mode === 'file' && !state.view.focusId ? 'Откройте карту из файла или найдите файл слева и выберите «В центр карты».'
      : 'Нет узлов с такими фильтрами. Поиск слева работает по всему проекту.';
  persist();
}
function renderDetails(): void {
  const hasSelection = selected.nodeIds.length + selected.relationIds.length > 0;
  const group = activeGroup();
  const canMark = !!group && hasSelection;
  const allMarked = selected.nodeIds.every(id => group?.files.some(mark => sameFile(mark.file, state.graph.nodes.find(node => node.id === id)?.file)))
    && selected.relationIds.every(id => { const edge = state.graph.relations.find(edge => edge.id === id); return !!edge && group?.relations.some(mark => relationMarked(mark, edge)); });
  saveNote.disabled = !canMark || !allMarked || !!pendingNote;
  note.disabled = !!pendingNote;
  noteHint.textContent = canMark && !allMarked ? 'Для заметки сначала добавьте выбранные элементы в группу.' : '';
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
  if (noteDraft.key !== noteKey) noteDraft = { key: noteKey, text: currentNote, dirty: false };
  else if (!noteDraft.dirty && !pendingNote) noteDraft.text = currentNote;
  if (note.value !== noteDraft.text) note.value = noteDraft.text;
  const diagnostics = state.graph.diagnostics;
  problemSummary.textContent = `Диагностика (${diagnostics.length}) · неразрешённых обращений ${state.graph.unresolved.length}`;
  problemList.replaceChildren();
  for (const item of diagnostics.slice(0, 100)) {
    const source = state.graph.nodes.find(node => node.id === item.fileId);
    problemList.append(element('p', 'hint', `${source?.file?.path ? `${source.file.path}: ` : ''}${item.message}`));
  }
  if (diagnostics.length > 100) problemList.append(element('p', 'hint', 'Показаны первые 100 диагностик.'));
}
function appendRelations(edges: Relation[], endpoint: 'sourceId' | 'targetId'): void {
  for (const edge of edges.slice(0, 100)) {
    const node = state.graph.nodes.find(item => item.id === edge[endpoint]);
    const row = button(`${node?.label ?? edge[endpoint]} · ${edge.kind}${edge.certainty === 'inferred' ? ' · ?' : ''}`, () => {
      selected = { nodeIds: [], relationIds: [edge.id] }; canvas.select([], [edge.id]); renderDetails();
    }, node?.file?.path ?? edge.specifier ?? 'Показать связь');
    row.className = 'relation-choice'; details.append(row);
  }
  if (edges.length > 100) details.append(element('p', 'hint', 'Показаны первые 100 связей.'));
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
      if (message.ok && pendingNote.key === noteDraft.key) noteDraft.dirty = false;
      pendingNote = undefined;
    }
    renderDetails(); return;
  }
  if (message?.type === 'status') {
    if (typeof message.status !== 'string' || !Number.isInteger(message.revision) || message.revision < state.graph.revision) return;
    state.status = message.status; renderStatus(); return;
  }
  if (message?.type !== 'state' || !message.graph || !message.view || !Array.isArray(message.graph.nodes)) return;
  if (message.graph.revision < state.graph.revision) return;
  state = message;
  const nodeIds = new Set(state.graph.nodes.map(node => node.id));
  const edgeIds = new Set(state.graph.relations.map(edge => edge.id));
  selected.nodeIds = selected.nodeIds.filter(id => nodeIds.has(id)); selected.relationIds = selected.relationIds.filter(id => edgeIds.has(id));
  forcedIds = new Set([...forcedIds].filter(id => nodeIds.has(id)));
  render();
});
window.addEventListener('pagehide', () => { canvasState = canvas.state(); persist(); canvas.destroy(); panels.destroy(); groupControls.destroy(); depthMenu.destroy(); });
render();
api.postMessage({ type: 'ready' });
