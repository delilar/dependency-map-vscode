import type { GraphNode, Relation } from '../shared/model';
import type { HostState, UiMessage } from '../shared/protocol';
import type { EvidencePath, QuerySpec, QueryResult, TaskContextData } from '../shared/query-model';
import type { CanvasSelection } from './graph';

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
const button = (text: string, action: () => void) => {
  const node = make('button', text); node.type = 'button'; node.addEventListener('click', action); return node;
};
const control = (text: string, input: HTMLElement) => {
  const node = make('label', '', 'control'); input.setAttribute('aria-label', text); node.append(make('span', text), input); return node;
};
const check = (text: string, checked: boolean) => {
  const input = make('input'); input.type = 'checkbox'; input.checked = checked;
  const label = make('label', '', 'check'); label.append(input, document.createTextNode(text)); return { label, input };
};
const outcomeLabels: Record<string, string> = {
  found: 'Найдены подтверждённые основания', notFoundWithinScope: 'Не найдено в доступном индексе',
  notFoundWithinLimits: 'Поиск ограничен — отсутствие связи не доказано', unknown: 'Данных недостаточно для полного ответа',
  resolved: 'Символ разрешён', ambiguous: 'Символ неоднозначен — точная декларация не выбрана',
  unresolved: 'Символ не найден или больше не доступен', unsupported: 'Точный фокус не поддержан для этой связи'
};
const stateLabels: Record<string, string> = { running: 'Выполняется', ready: 'Готово', cancelled: 'Отменено', failed: 'Ошибка', stale: 'Устарело' };
const indexLabels: Record<string, string> = { empty: 'Индекс отсутствует', building: 'Индекс строится', ready: 'Индекс готов', stale: 'Индекс устарел', failed: 'Ошибка индекса', cancelled: 'Пересчёт отменён' };
const reasonLabels: Record<string, string> = {
  depth: 'Достигнута глубина', maxNodes: 'Достигнут предел файлов', maxRelations: 'Достигнут предел связей', deadline: 'Достигнуто ограничение времени',
  missingSeed: 'Исходный файл недоступен', unresolved: 'Есть неразрешённые обращения', nodeOnly: 'Часть файлов индексируется без разбора содержимого',
  buildMismatch: 'Сборки различаются', protocolMismatch: 'Версии протокола несовместимы', legacyWebview: 'Открыта старая вкладка карты'
};

export function witnessSteps(witness: EvidencePath, nodes: ReadonlyMap<string, GraphNode>, relations: ReadonlyMap<string, Relation>): string {
  const name = (id: string) => { const node = nodes.get(id); return node?.file ? `${node.file.rootId}/${node.file.path}` : node?.label ?? id; };
  const steps = witness.relationIds.flatMap(id => { const edge = relations.get(id); return edge ? [`${name(edge.sourceId)} → ${name(edge.targetId)}`] : []; });
  return steps.length ? steps.join(' · ') : witness.nodeIds.map(name).join(', ');
}

export interface WorkbenchCallbacks {
  send(message: UiMessage): void;
  reveal(nodeIds: string[], relationIds?: string[]): void;
  select(nodeId: string): void;
  contextData(): TaskContextData;
  beforeRestore(): Promise<boolean>;
}

/** The query answer remains independent from the currently filtered canvas. */
export class AnalysisWorkbench {
  readonly element = make('details', '', 'analysis-workbench');
  readonly summary = make('section', '', 'query-summary');
  readonly tasks = make('details', '', 'task-contexts');
  readonly diagnostics = make('details', '', 'runtime-diagnostics');
  private state?: HostState;
  private selected: CanvasSelection = { nodeIds: [], relationIds: [] };
  private visible = new Set<string>();
  private readonly impactDepth = make('select');
  private readonly inferred = check('Включать предполагаемые связи', false);
  private readonly types = check('Включать type-only импорты', true);
  private readonly from = make('select');
  private readonly to = make('select');
  private readonly fileSearch = make('input');
  private readonly pathHint = make('p', 'Направление: от импортирующего к импортируемому. Подтверждённые import/reexport. До 10 000 файлов / 50 000 связей / 1500 мс.', 'hint');
  private readonly operation = make('p', '', 'analysis-status');
  private readonly queryList = make('div', '', 'query-results');
  private readonly branchList = make('div', '', 'branch-results');
  private readonly git = make('details', '', 'git-changes');
  private readonly gitList = make('div');
  private readonly gitStatus = make('p', '', 'hint');
  private readonly gitRepos = make('select');
  private readonly taskMessage = make('p', '', 'hint');
  private readonly taskPreview = make('div', '', 'task-preview');
  private readonly taskGroups = make('select');
  private readonly taskSave: HTMLButtonElement;
  private readonly taskRestore: HTMLButtonElement;
  private readonly taskDelete: HTMLButtonElement;
  private readonly runtime = make('div');
  private readonly returnButton: HTMLButtonElement;
  private readonly repeatButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly impactButton: HTMLButtonElement;
  private readonly pathButton: HTMLButtonElement;
  private readonly gitImpact: HTMLButtonElement;
  private resultKey = '';
  private graphKey = '';
  private taskKey = '';
  private gitKey = '';
  private listLimit = 100;

  constructor(private readonly callbacks: WorkbenchCallbacks) {
    this.element.append(make('summary', 'Исследовать зависимости'));
    const body = make('div', '', 'analysis-controls');
    for (let i = 1; i <= 20; i++) { const option = make('option', String(i)); option.value = String(i); this.impactDepth.append(option); }
    this.impactButton = button('Оценить влияние выбранного файла', () => {
      const node = this.selectedFile(); if (node) this.startImpact(node.id);
    });
    body.append(control('Глубина влияния', this.impactDepth), this.inferred.label, this.types.label, this.impactButton,
      make('p', 'Потенциальные потребители по статическим связям. Найденный тест — кандидат для проверки, а не измерение покрытия.', 'hint'));
    const path = make('details', '', 'path-query'); path.append(make('summary', 'Путь между файлами'));
    this.fileSearch.type = 'search'; this.fileSearch.placeholder = 'Найти файл для выбора концов пути'; this.fileSearch.addEventListener('input', () => this.updateFileChoices());
    this.pathButton = button('Найти направленный путь', () => this.start({ kind: 'path', fromId: this.from.value, toId: this.to.value }));
    path.append(control('Поиск файлов пути', this.fileSearch), control('Откуда', this.from), control('Куда', this.to),
      button('Поменять направление', () => { const value = this.from.value; this.from.value = this.to.value; this.to.value = value; }), this.pathHint, this.pathButton);
    body.append(path); this.element.append(body);

    this.operation.setAttribute('role', 'status'); this.operation.setAttribute('aria-live', 'polite');
    this.queryList.setAttribute('aria-label', 'Результаты аналитического запроса');
    this.returnButton = button('Вернуться к обычной карте', () => this.callbacks.send({ type: 'leaveAnalysis' }));
    this.repeatButton = button('Повторить запрос', () => { const query = this.state?.analytics?.active?.query; if (query) this.start(query); });
    this.cancelButton = button('Отменить запрос', () => this.callbacks.send({ type: 'cancelQuery' }));
    const summaryActions = make('div', '', 'actions'); summaryActions.append(this.returnButton, this.repeatButton, this.cancelButton,
      button('Показать весь результат', () => { const result = this.state?.analytics?.active?.result; if (result) this.callbacks.reveal(result.nodeIds, result.relationIds); }));
    this.summary.append(this.operation, summaryActions); this.element.append(this.queryList, this.branchList);

    this.git.append(make('summary', 'Текущие изменения Git'));
    const gitActions = make('div', '', 'actions'); this.gitImpact = button('Оценить влияние доступных изменений', () => this.callbacks.send({ type: 'gitState', action: 'impact', repoId: this.gitRepos.value || undefined }));
    gitActions.append(button('Перечитать наблюдаемое состояние', () => this.callbacks.send({ type: 'gitState', action: 'observe' })),
      button('Открыть Source Control', () => this.callbacks.send({ type: 'gitState', action: 'sourceControl' })), this.gitImpact);
    this.gitRepos.setAttribute('aria-label', 'Репозиторий Git'); this.gitRepos.addEventListener('change', () => this.renderGit(true));
    this.git.append(this.gitStatus, this.gitRepos, gitActions, make('p', 'Последнее наблюдаемое состояние провайдера и текущий граф с буферами редактора. Это не граф staged-версии. Перечитывание не запускает git status.', 'hint'), this.gitList);
    this.element.append(this.git);

    this.tasks.append(make('summary', 'Мой вид задачи (локально)'));
    this.taskGroups.setAttribute('aria-label', 'Группа локального контекста');
    this.taskSave = button('Сохранить мой вид', () => { const id = this.state?.view.activeGroupId; if (id) this.callbacks.send({ type: 'taskContext', action: 'save', groupId: id, data: this.callbacks.contextData() }); });
    this.taskRestore = button('Предпросмотр сохранённого вида', () => { if (this.taskGroups.value) this.callbacks.send({ type: 'taskContext', action: 'preview', groupId: this.taskGroups.value }); });
    this.taskDelete = button('Удалить локальный вид', () => { if (this.taskGroups.value) this.callbacks.send({ type: 'taskContext', action: 'delete', groupId: this.taskGroups.value }); });
    const taskActions = make('div', '', 'actions'); taskActions.append(this.taskSave, this.taskRestore, this.taskDelete);
    this.tasks.append(make('p', 'Одна ручная точка возврата для группы. Общие пометки и JSON не меняются. Восстановление закрепляет карту; следование включается отдельно.', 'hint'),
      this.taskGroups, taskActions, this.taskMessage, this.taskPreview);

    this.diagnostics.append(make('summary', 'Версии и актуальность'), this.runtime,
      button('Просмотреть диагностику', () => this.callbacks.send({ type: 'diagnostics', action: 'preview' })),
      button('Перезагрузить окно VS Code', () => this.callbacks.send({ type: 'diagnostics', action: 'reload' })));
    this.summary.hidden = true;
  }

  private sendable(): boolean { return this.state?.analytics?.runtime.compatible === true && this.state.analytics.index.state === 'ready'; }
  private selectedFile(): GraphNode | undefined {
    return this.state?.graph.nodes.find(n => n.id === (this.selected.nodeIds[0] ?? this.state?.view.focusId) && n.file);
  }
  private start(query: QuerySpec): void {
    if (!this.sendable()) return;
    this.element.open = true; this.listLimit = 100;
    this.callbacks.send({ type: 'startQuery', query });
  }
  startImpact(nodeId: string): void { this.start({ kind: 'impact', seeds: [nodeId], depth: Number(this.impactDepth.value), includeInferred: this.inferred.input.checked, includeTypes: this.types.input.checked }); }
  fileActions(node: GraphNode): HTMLElement {
    const actions = make('div', '', 'actions analytical-actions');
    if (!node.file) return actions;
    const impact = button('Кто может зависеть от изменения', () => this.startImpact(node.id)); impact.disabled = !this.sendable();
    const from = button('Путь отсюда…', () => { this.element.open = true; (this.element.querySelector('.path-query') as HTMLDetailsElement).open = true; this.fileSearch.value = ''; this.updateFileChoices(); this.from.value = node.id; this.to.focus(); });
    actions.append(impact, from);
    const branches = this.state?.analytics?.branches ?? [];
    for (const [direction, title] of [['incoming', 'Ещё входящие'], ['outgoing', 'Ещё исходящие']] as const) {
      const branch = branches.find(b => b.anchorId === node.id && b.direction === direction);
      const expand = button(`${title}${branch ? ` (${branch.depth} ур.)` : ''}`, () => this.callbacks.send({ type: 'branch', nodeId: node.id, direction, action: 'expand' }));
      expand.disabled = !this.sendable() || (this.state?.view.mode === 'project' && !this.state?.analytics?.active) || (branch?.depth ?? 0) >= 20;
      expand.title = this.state?.view.mode === 'project' && !this.state?.analytics?.active ? 'В полном проекте все доступные файлы уже включены. Перейдите к карте файла.' : 'Добавить один физический шаг только в этом направлении, сохранив карту';
      actions.append(expand);
      if (branch) actions.append(button(`Свернуть ${direction === 'incoming' ? 'входящую' : 'исходящую'} ветку`, () => this.callbacks.send({ type: 'branch', nodeId: node.id, direction, action: 'collapse' })));
    }
    const exports = this.state?.graph.exports?.filter(e => e.fileId === node.id && e.kind !== 'star') ?? [];
    if (exports.length) {
      const symbols = make('details'); symbols.append(make('summary', `Экспорты (${exports.length})`));
      for (const entry of exports) {
        const focus = button(`${entry.name}${entry.namespace === 'type' ? ' · type' : ''} — фокус символа`, () => this.start({ kind: 'symbol', fileId: node.id, exported: entry.name, namespace: entry.namespace }));
        focus.disabled = !this.sendable(); symbols.append(focus);
      }
      actions.append(symbols);
    }
    return actions;
  }
  bindingActions(edge: Relation): HTMLElement {
    const actions = make('div', '', 'actions analytical-actions');
    for (const binding of edge.bindings) {
      const focus = button(`Фокус: ${binding.typeOnly ? 'type ' : ''}${binding.imported}${binding.local && binding.local !== binding.imported ? ` as ${binding.local}` : ''}`,
        () => this.start({ kind: 'symbol', fileId: edge.targetId, exported: binding.imported, namespace: binding.typeOnly ? 'type' : 'value' }));
      focus.disabled = !this.sendable(); actions.append(focus);
    }
    return actions;
  }
  update(state: HostState, selected: CanvasSelection, visible: Set<string>): void {
    this.state = state; this.selected = selected; this.visible = visible;
    const graphKey = JSON.stringify([state.graph.revision, state.analytics?.index.version.epoch, state.graph.nodes.length]);
    if (graphKey !== this.graphKey) { this.graphKey = graphKey; this.updateFileChoices(); }
    this.element.hidden = !state.analytics;
    this.tasks.hidden = !state.analytics;
    this.diagnostics.hidden = !state.analytics;
    this.impactButton.disabled = !this.sendable() || !this.selectedFile(); this.pathButton.disabled = !this.sendable() || !this.from.value || !this.to.value;
    this.renderQuery(); this.renderBranches(); this.renderGit(); this.renderTask(); this.renderRuntime();
  }
  private updateFileChoices(): void {
    if (!this.state) return;
    const selected = [this.from.value, this.to.value];
    const term = this.fileSearch.value.trim().toLocaleLowerCase();
    const files = this.state.graph.nodes.filter(n => n.file && (!term || `${n.file.path} ${n.projectName ?? n.projectId} ${n.file.rootId}`.toLocaleLowerCase().includes(term) || selected.includes(n.id)));
    for (const input of [this.from, this.to]) {
      input.replaceChildren(...files.map(n => { const option = make('option', `${n.projectName ?? n.projectId}/${n.file!.path} · ${n.file!.rootId}`); option.value = n.id; return option; }));
    }
    this.from.value = files.some(n => n.id === selected[0]) ? selected[0] : this.selectedFile()?.id ?? files[0]?.id ?? '';
    this.to.value = files.some(n => n.id === selected[1]) ? selected[1] : files[0]?.id ?? '';
    this.pathButton.disabled = !this.sendable() || !this.from.value || !this.to.value;
  }
  private renderQuery(): void {
    const active = this.state?.analytics?.active;
    this.summary.hidden = !active;
    if (!active) { this.queryList.replaceChildren(); this.resultKey = ''; return; }
    const result = active.result?.operation === 'success' ? active.result : active.previousResult ?? active.result;
    const previous = !!result && result === active.previousResult;
    this.cancelButton.disabled = active.state !== 'running'; this.repeatButton.disabled = !this.sendable() || active.state === 'running';
    const kinds = { impact: 'Влияние', path: 'Путь импортов', symbol: 'Символ', neighbourhood: 'Ветка' };
    const found = result?.nodeIds.length ?? 0, visible = result?.nodeIds.filter(id => this.visible.has(id)).length ?? 0;
    this.operation.textContent = `${kinds[active.query.kind]} · ${stateLabels[active.state]}${previous ? ' · показан предыдущий завершённый результат' : ''} · ${found} файлов в результате / ${visible} на карте / ${found - visible} скрыто. Карта закреплена.`;
    const key = JSON.stringify([active.requestId, active.state, result, [...this.visible], this.listLimit]);
    if (key === this.resultKey) return;
    this.resultKey = key; this.queryList.replaceChildren();
    if (previous) this.queryList.append(make('p', 'Предыдущий результат относится к прежним входам запроса. Он сохранён для чтения и не является ответом на новый запрос.', 'unresolved'));
    if (!result) { this.queryList.append(make('p', active.state === 'running' ? 'Запрос по полному индексу…' : 'Результат пока отсутствует.', 'hint')); return; }
    const coverage = { complete: 'просмотрена выбранная область', partial: 'частичный результат', unknown: 'полнота неизвестна' };
    this.queryList.append(make('h3', outcomeLabels[result.outcome] ?? result.outcome),
      make('p', `${coverage[result.coverage]} · ${result.freshness === 'stale' ? 'результат устарел' : 'версия результата актуальна'} · ревизия ${result.graph.revision}`, 'hint'),
      make('p', `Просмотрено файлов: ${result.visitedNodes}, связей: ${result.examinedRelations}. Пределы: ${result.limits.maxNodes} / ${result.limits.maxRelations} / ${result.limits.deadlineMs} мс.`, 'hint'));
    if (result.reasonCodes.length) this.queryList.append(make('p', result.reasonCodes.map(r => reasonLabels[r] ?? r).join(' · '), 'unresolved'));
    if (result.nodeIds.length > 500) this.queryList.append(make('p', 'Предел карты — 500 файлов. Полный результат остаётся в списке; показывайте нужные файлы или цепочки отдельно. Это не ограничение полноты запроса.', 'hint'));
    if (result.kind === 'symbol') {
      this.queryList.append(make('p', 'Статические import/reexport, без обещания вызовов или data flow.', 'hint'));
      for (const candidate of result.resolution.candidates) {
        const node = this.state!.graph.nodes.find(n => n.id === candidate.fileId);
        this.queryList.append(make('p', `Кандидат: ${node?.file?.path ?? candidate.fileId} · ${candidate.name} · ${candidate.namespace}`, 'path'));
      }
    }
    if (result.kind === 'impact') {
      this.queryList.append(make('p', `Прямых: ${result.directIds.length} · косвенных: ${result.indirectIds.length} · тестов-кандидатов: ${result.testIds.length}`, 'small'),
        make('p', 'Тесты-кандидаты найдены по статическим связям. Это не доказательство покрытия или безопасности изменения.', 'hint'));
    }
    const witnesses = new Map(result.witnesses.map(w => [w.nodeId, w]));
    const nodesById = new Map(this.state!.graph.nodes.map(node => [node.id, node]));
    const relationsById = new Map(this.state!.graph.relations.map(edge => [edge.id, edge]));
    const ids = result.kind === 'impact' ? [...result.directIds, ...result.indirectIds] : result.nodeIds;
    for (const id of ids.slice(0, this.listLimit)) {
      const node = this.state!.graph.nodes.find(n => n.id === id); if (!node) continue;
      const row = make('article', '', 'query-row'); row.dataset.nodeId = id;
      const classification = result.kind === 'impact' ? result.testIds.includes(id) ? ' · тест-кандидат' : result.directIds.includes(id) ? ' · прямой' : ' · косвенный' : '';
      row.append(button(`${node.file?.path ?? node.label}${classification}${this.visible.has(id) ? '' : ' · скрыт фильтром / областью'}`, () => this.callbacks.select(id)),
        button('Показать на карте', () => this.callbacks.reveal([id])), button('Открыть файл', () => this.callbacks.send({ type: 'openFile', nodeId: id })));
      const witness = witnesses.get(id);
      if (witness) {
        row.append(make('p', witnessSteps(witness, nodesById, relationsById), 'path'));
        for (const relationId of witness.relationIds) {
          const edge = this.state!.graph.relations.find(e => e.id === relationId); if (!edge) continue;
          row.append(button(`Основание: ${edge.specifier ?? edge.kind}${edge.bindings.some(b => b.typeOnly) ? ' · содержит type-only' : ''}`, () => this.callbacks.send({ type: 'openEvidence', relationId })));
        }
        row.append(button('Показать цепочку', () => this.callbacks.reveal(witness.nodeIds, witness.relationIds)));
      }
      this.queryList.append(row);
    }
    if (ids.length > this.listLimit) this.queryList.append(button(`Показать следующие ${Math.min(100, ids.length - this.listLimit)}`, () => { this.listLimit += 100; this.renderQuery(); }));
    if (!ids.length) this.queryList.append(make('p', 'В доступном индексе результаты не найдены. Неизвестные зависимости и ограничения не позволяют считать изменение безопасным.', 'hint'));
  }
  private renderGit(force = false): void {
    const git = this.state?.analytics?.git;
    const key = JSON.stringify([git, this.gitRepos.value]); if (!force && key === this.gitKey) return;
    this.gitKey = key; this.gitList.replaceChildren();
    this.gitStatus.textContent = !git ? 'Состояние Git ещё не наблюдалось.' : git.providerState === 'available'
      ? `Состояние провайдера наблюдалось ${new Date(git.observedAt).toLocaleTimeString()}. Это не время проверки диска.${git.omissions ? ` Не показано строк: ${git.omissions}.` : ''}`
      : `Git недоступен: ${git.providerState}. Остальные режимы карты работают.`;
    const selectedRepo = this.gitRepos.value;
    const repos = [['', 'Все репозитории'], ...(git?.repositories ?? []).map(r => [r.id, `${r.label}${r.state === 'failed' ? ' · ошибка' : ''}`])];
    this.gitRepos.replaceChildren(...repos.map(([id, label]) => { const option = make('option', label); option.value = id; return option; }));
    this.gitRepos.value = repos.some(([id]) => id === selectedRepo) ? selectedRepo : '';
    this.gitRepos.hidden = repos.length < 3;
    const rows = git?.rows.filter(r => !this.gitRepos.value || r.repoId === this.gitRepos.value) ?? [];
    this.gitImpact.disabled = !this.sendable() || !rows.some(r => !!r.indexedNodeId);
    if (git?.reasonCodes.length) this.gitList.append(make('p', git.reasonCodes.join(' · '), 'unresolved'));
    for (const row of rows.slice(0, 300)) {
      const badges = [row.staged ? 'staged' : '', row.unstaged ? 'unstaged' : '', row.untracked ? 'untracked' : '', row.conflict ? 'conflict' : '', row.dirty ? 'несохранённый редактор' : ''].filter(Boolean);
      const item = make('article', '', 'git-row');
      const repo = git?.repositories.find(r => r.id === row.repoId)?.label ?? row.repoId;
      const crossRoot = row.originalFile && row.file && row.originalFile.rootId !== row.file.rootId;
      const original = row.originalRelativePath ? `${crossRoot ? `${row.originalFile!.rootId}/` : ''}${row.originalRelativePath} → ` : '';
      const current = `${crossRoot ? `${row.file!.rootId}/` : ''}${row.relativePath}`;
      item.append(make('p', `${repo}/${original}${current}`, 'path'), make('p', `${badges.join(' · ')} · ${row.scopeStatus}`, 'small'));
      if (row.indexedNodeId) { const id = row.indexedNodeId; item.append(button('Показать файл', () => this.callbacks.select(id)), button('Влияние файла', () => this.startImpact(id))); }
      else item.append(make('p', 'Текущие связи недоступны; исторические рёбра не восстанавливаются.', 'hint'));
      this.gitList.append(item);
    }
    if (rows.length > 300) this.gitList.append(make('p', `В списке первые 300 из ${rows.length}. Выберите репозиторий для уточнения.`, 'hint'));
    if (git?.providerState === 'available' && !rows.length) this.gitList.append(make('p', 'В наблюдаемом состоянии провайдера изменений не найдено.', 'hint'));
  }
  private renderBranches(): void {
    this.branchList.replaceChildren();
    const branches = this.state?.analytics?.branches ?? [];
    if (branches.length) this.branchList.append(make('h3', 'Раскрытые ветки'));
    for (const branch of branches) {
      const anchor = this.state?.graph.nodes.find(n => n.id === branch.anchorId);
      const result = branch.result;
      const count = result?.nodeIds.length ?? 0;
      const hidden = result?.nodeIds.filter(id => !this.visible.has(id)).length ?? 0;
      const row = make('article', '', 'query-row');
      row.append(make('p', `${anchor?.file?.path ?? branch.anchorId} · ${branch.direction === 'incoming' ? 'входящие' : 'исходящие'} · ${branch.depth} ур. · ${count} файлов / ${hidden} скрыто`, 'small'));
      if (result) {
        if (count > 500) row.append(make('p', 'Предел карты — 500 файлов. Часть ветки скрыта ограничением отображения, независимо от полноты запроса.', 'hint'));
        row.append(make('p', `${outcomeLabels[result.outcome] ?? result.outcome}${result.reasonCodes.length ? ` · ${result.reasonCodes.join(', ')}` : ''}. Общие узлы могут оставаться из других веток или базовой глубины.`, 'hint'),
          button('Показать файлы ветки вне фильтра', () => this.callbacks.reveal(result.nodeIds, result.relationIds)));
      } else row.append(make('p', 'Ветка ожидает актуального индекса.', 'hint'));
      row.append(button('Свернуть только эту ветку', () => this.callbacks.send({ type: 'branch', nodeId: branch.anchorId, direction: branch.direction, action: 'collapse' })));
      this.branchList.append(row);
    }
  }
  private renderTask(): void {
    const tasks = this.state?.analytics?.taskContexts;
    const key = JSON.stringify([tasks, this.state?.view.activeGroupId, this.state?.annotations]); if (key === this.taskKey) return;
    this.taskKey = key; this.taskMessage.textContent = tasks?.message ?? '';
    const annotations = this.state?.annotations as { groups?: { id: string; name: string }[] } | undefined;
    const ids = [...new Set([...(tasks?.savedGroupIds ?? []), ...(tasks?.orphanedGroupIds ?? [])])];
    const selected = this.taskGroups.value;
    this.taskGroups.replaceChildren(...ids.map(id => { const group = annotations?.groups?.find(g => g.id === id); const option = make('option', group?.name ?? `${id} · группа недоступна`); option.value = id; return option; }));
    this.taskGroups.value = ids.includes(selected) ? selected : ids.includes(this.state?.view.activeGroupId ?? '') ? this.state!.view.activeGroupId! : ids[0] ?? '';
    this.taskSave.disabled = !this.state?.analytics?.runtime.compatible || !annotations?.groups?.some(g => g.id === this.state?.view.activeGroupId);
    this.taskRestore.disabled = this.taskDelete.disabled = !ids.length;
    this.taskPreview.replaceChildren(); const preview = tasks?.preview;
    if (!preview) return;
    this.taskPreview.append(make('p', `Сохранено ${new Date(preview.savedAt).toLocaleString()}. Аналитика будет пересчитана на текущем индексе.`, 'hint'));
    if (preview.groupChanged) this.taskPreview.append(make('p', 'Общая группа изменилась: будут использованы её текущие данные.', 'unresolved'));
    if (preview.groupMissing) this.taskPreview.append(make('p', 'Общая группа недоступна. Восстановление не создаёт группу заново.', 'unresolved'));
    if (preview.missingNodeIds.length) this.taskPreview.append(make('p', `Недоступные ссылки (${preview.missingNodeIds.length}): ${preview.missingNodeIds.join(', ')}. Похожие имена не подставляются; используйте ручную привязку корней.`, 'unresolved'));
    if (preview.reasonCodes.length) this.taskPreview.append(make('p', preview.reasonCodes.join(' · '), 'unresolved'));
    const apply = button('Восстановить доступную часть', () => { void this.callbacks.beforeRestore().then(ok => { if (ok) this.callbacks.send({ type: 'taskContext', action: 'restore', groupId: preview.groupId }); }); });
    this.taskPreview.append(apply);
    if (preview.data.view.follow || preview.reasonCodes.includes('followPaused')) this.taskPreview.append(make('p', 'Ранее было включено следование. После восстановления включите его явно, когда будете готовы.', 'hint'));
  }
  private renderRuntime(): void {
    const analytics = this.state?.analytics; this.runtime.replaceChildren(); if (!analytics) return;
    const { runtime, index } = analytics;
    for (const [name, identity] of [['Host', runtime.host], ['Webview', runtime.webview], ['Worker', runtime.worker]] as const) this.runtime.append(make('p', `${name}: ${identity ? `${identity.extensionVersion} · ${identity.buildId} · протокол ${identity.protocolVersion}` : 'не согласован'}`, 'path'));
    this.runtime.append(make('p', `Установлено: ${runtime.installedVersion}. ${indexLabels[index.state]} · ревизия ${index.version.revision}.`, 'hint'));
    if (!runtime.compatible) this.runtime.append(make('p', 'Новые действия заблокированы: сборки не согласованы. Перезагрузите окно и откройте карту снова.', 'error'));
    if (runtime.reasonCodes.length || index.reasonCodes.length) this.runtime.append(make('p', [...runtime.reasonCodes, ...index.reasonCodes].map(r => reasonLabels[r] ?? r).join(' · '), 'unresolved'));
    const coverage = this.state?.graph.coverage ?? [];
    const limited = coverage.filter(c => c.status !== 'parsed');
    if (limited.length) this.runtime.append(make('p', `Ограничения форматов: ${limited.length} файлов без полного разбора (${[...new Set(limited.flatMap(c => c.reasonCodes))].join(', ')}). Свежесть индекса не означает полноту анализа.`, 'hint'));
  }
  showDiagnostics(text: string): void {
    const dialog = make('dialog', '', 'review-dialog'); dialog.setAttribute('aria-label', 'Предпросмотр диагностических сведений');
    const preview = make('textarea'); preview.readOnly = true; preview.rows = 12; preview.value = text; preview.setAttribute('aria-label', 'Диагностические сведения перед копированием');
    dialog.append(make('h2', 'Диагностика перед копированием'), make('p', 'Проверьте текст. Копирование локальное; внешней отправки нет.', 'hint'), preview,
      button('Скопировать просмотренную диагностику', () => this.callbacks.send({ type: 'diagnostics', action: 'copy' })), button('Закрыть', () => dialog.close()));
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  }
}

export function chooseDraftAction(): Promise<'save' | 'discard' | 'stay'> {
  return new Promise(resolve => {
    const dialog = make('dialog', '', 'review-dialog'); dialog.setAttribute('aria-label', 'Несохранённые свойства или заметка');
    let result: 'save' | 'discard' | 'stay' = 'stay';
    dialog.append(make('h2', 'Есть несохранённые изменения'), make('p', 'Сохранить свойства группы и заметку перед переходом? При ошибке текущий вид и черновик останутся.'),
      ...([['save', 'Сохранить'], ['discard', 'Отбросить'], ['stay', 'Остаться']] as const).map(([value, text]) => button(text, () => { result = value; dialog.close(); })));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true }); document.body.append(dialog); dialog.showModal();
  });
}
