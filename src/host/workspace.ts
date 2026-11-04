import * as vscode from 'vscode';
import path from 'node:path';
import { access, realpath, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { AnalysisClient } from './analysis-client';
import { MapPanel } from './map-panel';
import { resolveAllowedFile, sameFilePath } from './navigation';
import { applyRootBindings } from './root-bindings';
import { extractEnvironmentKeys, isEnvironmentFile } from './environment';
import { AnnotationStore, applyAnnotationMutation, createAnnotations, type AnnotationMutation, type AnnotationsDocument, type RelationRef } from './annotations';
import { emptyGraph, fileId, initialView, type GraphNode, type GraphSnapshot, type SourceOverlay, type ViewState, type WorkspaceRoot } from '../shared/model';
import { isSavedUiState, isViewState, type UiMessage } from '../shared/protocol';
import { buildInfo, compatibleBuild } from '../shared/build-info';
import { queryLimits, querySeeds, sameIndex, type AnalyticsState, type BranchIntent, type GitStatusSnapshot, type IndexState, type RuntimeState, type QuerySpec, type TaskContextState } from '../shared/query-model';
import { QueryCoordinator } from './query-coordinator';
import { PassiveGitState, type CachedGitExtension } from './git-state';
import { LocalTaskContextStore, fingerprintGroup, previewTaskContext } from './task-contexts';
import { formatDiagnostics } from './diagnostics';
import { inScope, normalizeScope, scopedGraph, scopeSignature } from '../shared/scope';
import { exportTables, resolveExport } from '../analysis/export-resolution';

const defaultExclude = ['.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', '.cache', '.turbo'];

export class WorkspaceSession implements vscode.Disposable {
  private roots: WorkspaceRoot[] = [];
  private graph: GraphSnapshot = emptyGraph();
  private view: ViewState;
  private status = 'Open a file map to index the workspace.';
  private readonly client: AnalysisClient;
  private readonly panel: MapPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private opened = false;
  private disposed = false;
  private running = 0;
  private indexStale = true;
  private readonly changedPaths = new Set<string>();
  private annotationStore?: AnnotationStore;
  private annotationPath?: string;
  private annotations?: AnnotationsDocument;
  private annotationError?: string;
  private annotationQueue: Promise<void> = Promise.resolve();
  private initialized?: Promise<void>;
  private savedView = '';
  private readonly canSaveView: boolean;
  private index: IndexState = { version: { epoch: randomUUID(), revision: 0, scopeRevision: 0 }, state: 'empty', reasonCodes: [] };
  private runtime: RuntimeState = { host: buildInfo, installedVersion: buildInfo.extensionVersion, compatible: false, reasonCodes: ['webviewNotReady'] };
  private readonly queries = new QueryCoordinator();
  private branches: BranchIntent[] = [];
  private readonly branchRequests = new Map<string, string>();
  private exploreView?: ViewState;
  private git?: GitStatusSnapshot;
  private readonly gitProvider: PassiveGitState;
  private readonly taskStore: LocalTaskContextStore;
  private taskContexts: TaskContextState = { savedGroupIds: [], orphanedGroupIds: [] };
  private diagnosticPreview?: string;
  private taskPreviewGuard?: string;
  private uiStateToken?: string;
  private pendingRestoredQuery?: QuerySpec;

  constructor(private readonly context: vscode.ExtensionContext) {
    const currentSaved = context.workspaceState.get<unknown>('dependencyMap.view.v2');
    this.canSaveView = currentSaved === undefined || isViewState(currentSaved);
    const saved = currentSaved ?? context.workspaceState.get<unknown>('dependencyMap.view');
    this.view = isViewState(saved) ? saved : initialView();
    this.client = new AnalysisClient(path.join(context.extensionPath, 'dist', 'worker.cjs'), worker => {
      if (!worker) {
        this.invalidateQueries('workerUnavailable'); this.indexStale = true;
        this.index = { ...this.index, version: { ...this.index.version, epoch: randomUUID() }, state: 'failed', reasonCodes: ['workerUnavailable'] };
      }
      this.runtime = { ...this.runtime, worker }; this.updateCompatibility(); this.publish();
    });
    this.taskStore = new LocalTaskContextStore(context.workspaceState);
    this.gitProvider = new PassiveGitState(() => vscode.extensions.getExtension('vscode.git') as CachedGitExtension | undefined, () => {
      if (this.panel.isOpen()) { this.observeGit(); this.publish(); }
    });
    this.panel = new MapPanel(context.extensionUri, message => { void this.handle(message).catch(() => this.error('The requested action could not be completed.')); }, () => this.localState(), () => this.gitProvider.stop());
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) this.changed(event.document.uri); }),
      vscode.workspace.onDidSaveTextDocument(document => this.changed(document.uri)),
      vscode.workspace.onDidCloseTextDocument(document => this.changed(document.uri)),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!this.view.follow || !editor || editor.document.uri.scheme !== 'file') return;
        const id = this.idForUri(editor.document.uri);
        if (id && this.graph.nodes.some(node => node.id === id) && this.view.focusId !== id) { this.view.focusId = id; this.publish(); }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.invalidateQueries('scopeChanged');
        this.initialized = undefined;
        void this.initialize().then(() => { if (this.opened) return this.rebuild(); });
      }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dependencyMap')) { this.index = { ...this.index, version: { ...this.index.version, scopeRevision: this.index.version.scopeRevision + 1 } }; this.schedule(); } }),
      vscode.extensions.onDidChange(() => { if (this.panel.isOpen()) { this.gitProvider.watch(); this.observeGit(); this.publish(); } })
    );
  }

  private initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.initializeWorkspace();
    return this.initialized;
  }

  private async initializeWorkspace(): Promise<void> {
    this.index = { ...this.index, version: { ...this.index.version, scopeRevision: this.index.version.scopeRevision + 1 }, state: 'stale' };
    const bindings = this.context.workspaceState.get<Record<string, string>>('dependencyMap.rootBindings', {});
    this.roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => ({
      id: bindings[folder.uri.toString()] ?? randomUUID(), name: folder.name, path: folder.uri.fsPath
    }));
    const candidates: string[] = [];
    for (const root of this.roots) {
      const candidate = path.join(root.path, '.vscode', 'dependency-map.json');
      try { await this.validateAnnotationLocation(candidate); await access(candidate); candidates.push(candidate); } catch { /* No safe annotation file in this root. */ }
    }
    const previous = this.context.workspaceState.get<string>('dependencyMap.annotationPath');
    const selected = previous && candidates.includes(previous) ? previous : candidates.length === 1 ? candidates[0] : undefined;
    this.annotationStore = undefined;
    this.annotations = undefined;
    this.annotationPath = selected;
    this.annotationError = candidates.length > 1 && !selected ? 'Several annotation files found. Choose one when saving a mark.' : undefined;
    if (selected) {
      this.annotationStore = new AnnotationStore(selected);
      try {
        this.annotations = await this.annotationStore.load();
        this.bindAnnotationRoots();
      } catch { this.annotationError = 'Annotation file is invalid or unreadable. Its contents have been preserved.'; }
    }
    for (const root of this.roots) bindings[vscode.Uri.file(root.path).toString()] = root.id;
    await this.context.workspaceState.update('dependencyMap.rootBindings', bindings);
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    for (const root of this.roots) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root.path, '**/*'));
      this.watchers.push(watcher, watcher.onDidChange(uri => this.changed(uri)), watcher.onDidCreate(uri => this.changed(uri)), watcher.onDidDelete(uri => this.changed(uri)));
    }
    this.refreshTaskContexts();
  }

  private bindAnnotationRoots(): void {
    if (!this.annotations) return;
    const used = new Set<string>();
    for (const root of this.roots) {
      const exact = this.annotations.roots.find(item => item.id === root.id);
      const matches = this.annotations.roots.filter(item => item.label === root.name && !used.has(item.id));
      const saved = exact ?? (matches.length === 1 && this.roots.filter(item => item.name === root.name).length === 1 ? matches[0] : undefined)
        ?? (this.roots.length === 1 && this.annotations.roots.length === 1 ? this.annotations.roots[0] : undefined);
      if (saved) { root.id = saved.id; used.add(saved.id); }
    }
    const missing = this.annotations.roots.filter(item => !used.has(item.id));
    if (missing.length) this.annotationError = `${missing.length} saved root(s) are unbound. Run Dependency Map: Bind Shared Roots. Marks are preserved.`;
  }

  async open(mode: 'file' | 'project', uri?: vscode.Uri): Promise<void> {
    await this.initialize();
    if (!this.roots.length) { void vscode.window.showInformationMessage('Open a local project folder to use Dependency Map.'); return; }
    this.opened = true;
    const target = uri?.scheme === 'file' ? uri : vscode.window.activeTextEditor?.document.uri;
    this.view.mode = mode;
    if (target) this.view.focusId = this.idForUri(target) ?? this.view.focusId;
    this.panel.reveal();
    this.gitProvider.watch();
    this.observeGit();
    this.publish();
    if (!this.graph.revision || this.indexStale) await this.rebuild(!this.graph.revision);
  }

  async bindRoots(): Promise<void> {
    await this.initialize();
    if (!this.annotations) { void vscode.window.showInformationMessage('Create or select shared groups before binding roots.'); return; }
    const assignments: Record<string, string> = {};
    const occupied = new Set<string>();
    for (const saved of this.annotations.roots) {
      const options = this.roots.filter(root => !occupied.has(root.path)).map(root => ({ label: root.name, description: root.path, root }));
      const choice = await vscode.window.showQuickPick([{ label: 'Leave unbound', description: 'Keep marks for another folder or branch', root: undefined }, ...options], { placeHolder: `Bind saved root: ${saved.label}` });
      if (!choice) return;
      if (choice.root) { assignments[saved.id] = choice.root.path; occupied.add(choice.root.path); }
    }
    const oldFocus = this.graph.nodes.find(node => node.id === this.view.focusId)?.file;
    const focusedRoot = this.roots.find(root => root.id === oldFocus?.rootId)?.path;
    this.roots = applyRootBindings(this.roots, this.annotations.roots.map(root => root.id), assignments);
    const newFocusRoot = this.roots.find(root => root.path === focusedRoot);
    this.view.focusId = oldFocus && newFocusRoot ? fileId({ rootId: newFocusRoot.id, path: oldFocus.path }) : undefined;
    this.graph = emptyGraph();
    this.index = { ...this.index, version: { ...this.index.version, scopeRevision: this.index.version.scopeRevision + 1 }, state: 'stale' };
    this.invalidateQueries('rootBindingsChanged');
    const bindings: Record<string, string> = {};
    for (const root of this.roots) bindings[vscode.Uri.file(root.path).toString()] = root.id;
    await this.context.workspaceState.update('dependencyMap.rootBindings', bindings);
    this.annotationError = undefined;
    await this.rebuild();
  }

  inspect() {
    return { type: 'state' as const, graph: this.graph, view: this.view, status: this.status, roots: this.roots, annotations: this.annotations, annotationError: this.annotationError, localState: this.localState(), panelReady: this.panel.isReady(), analytics: this.analytics() };
  }

  async testMessage(message: UiMessage): Promise<void> { await this.handle(message); }

  private idForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const root = [...this.roots].sort((a, b) => b.path.length - a.path.length).find(item => {
      const relative = path.relative(item.path, uri.fsPath);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    return root ? fileId({ rootId: root.id, path: path.relative(root.path, uri.fsPath).split(path.sep).join('/') }) : undefined;
  }

  private changed(uri: vscode.Uri): void {
    if (!this.opened || uri.scheme !== 'file') return;
    if (this.annotationPath && sameFilePath(uri.fsPath, this.annotationPath)) {
      this.annotationQueue = this.annotationQueue.catch(() => {}).then(() => this.refreshAnnotations());
      return;
    }
    if (this.annotationPath && sameFilePath(path.dirname(uri.fsPath), path.dirname(this.annotationPath)) && /^dependency-map\.json\.[0-9a-f-]{36}\.tmp$/i.test(path.basename(uri.fsPath))) return;
    const segments = uri.fsPath.split(/[\\/]/);
    const excluded = vscode.workspace.getConfiguration('dependencyMap').get<string[]>('exclude', defaultExclude);
    if (segments.some(segment => ['node_modules', '.git'].includes(segment.toLowerCase()) || excluded.includes(segment))) return;
    if (this.idForUri(uri)) this.schedule();
    if (this.idForUri(uri)) this.changedPaths.add(uri.fsPath);
  }

  private schedule(): void {
    if (!this.opened || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.client.cancel();
    this.invalidateQueries('workspaceChanged');
    this.running++;
    this.status = 'Workspace changed; index is out of date.';
    this.indexStale = true;
    this.index = { ...this.index, state: 'stale', reasonCodes: ['workspaceChanged'] };
    this.observeGit();
    this.publish();
    if (!this.panel.isOpen()) return;
    this.timer = setTimeout(() => { this.timer = undefined; if (this.panel.isOpen()) void this.rebuild(false); }, 350);
  }

  async rebuild(full = true): Promise<void> {
    await this.initialize();
    if (!this.roots.length || this.disposed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const run = ++this.running;
    this.indexStale = true;
    this.invalidateQueries('indexBuilding');
    this.index = { ...this.index, state: 'building', reasonCodes: [] };
    this.status = 'Indexing workspace…';
    this.publish();
    const overlays: SourceOverlay[] = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' && this.idForUri(document.uri) && !document.uri.fsPath.split(/[\\/]/).some(part => ['node_modules', '.git'].includes(part.toLowerCase()))).map(document => ({
      path: document.uri.fsPath, version: document.version,
      ...(isEnvironmentFile(document.uri.fsPath) ? { envKeys: extractEnvironmentKeys(document.getText()) } : { text: document.getText() })
    }));
    try {
      const graph = await this.client.analyze({ roots: this.roots, options: { exclude: vscode.workspace.getConfiguration('dependencyMap').get<string[]>('exclude', defaultExclude) }, overlays, graphVersion: this.index.version, ...(full ? {} : { changedPaths: [...this.changedPaths] }) }, message => {
        if (run === this.running) { this.status = message; this.publish(); }
      });
      if (run !== this.running || !graph || this.disposed) return;
      this.graph = graph;
      this.changedPaths.clear();
      this.indexStale = false;
      this.index = { version: { ...this.index.version, revision: graph.revision }, state: 'ready', reasonCodes: graph.coverageReasons ?? [] };
      this.observeGit();
      this.refreshTaskContexts();
      if (this.view.follow && vscode.window.activeTextEditor) {
        const active = this.idForUri(vscode.window.activeTextEditor.document.uri);
        if (active && graph.nodes.some(node => node.id === active)) this.view.focusId = active;
      }
      this.status = `${graph.stats.files} files · ${graph.relations.length} relations · ${graph.unresolved.length} unresolved · ${Math.round(graph.stats.elapsedMs)} ms`;
      this.publish();
      for (const branch of this.branches) void this.runBranch(branch);
      if (this.pendingRestoredQuery) { const query = this.pendingRestoredQuery; this.pendingRestoredQuery = undefined; void this.startQuery(query); }
    } catch { if (run === this.running) { this.index = { ...this.index, state: 'failed', reasonCodes: ['analysisFailed'] }; this.error('Indexing failed. The previous graph is preserved; use Rebuild to retry.'); } }
  }

  private async handle(message: UiMessage): Promise<void> {
    switch (message.type) {
      case 'saveLocalState':
        if (message.contextToken === this.uiStateToken) {
          const existing = this.context.workspaceState.get<unknown>('dependencyMap.uiState.v2');
          if (existing === undefined || isSavedUiState(existing)) await this.context.workspaceState.update('dependencyMap.uiState.v2', message.state);
        }
        return;
      case 'ready':
        this.runtime = { ...this.runtime, webview: message.build };
        try { const installed = JSON.parse(await readFile(path.join(this.context.extensionPath, 'package.json'), 'utf8')); if (typeof installed.version === 'string') this.runtime = { ...this.runtime, installedVersion: installed.version.slice(0, 100) }; } catch { /* Running build identity remains authoritative. */ }
        this.updateCompatibility(); this.publish(); return;
      case 'startQuery': await this.startQuery(message.query); return;
      case 'cancelQuery':
        if (this.queries.active) this.client.cancelQuery(this.queries.active.requestId);
        this.queries.cancel(); this.publish(); return;
      case 'leaveAnalysis':
        this.pendingRestoredQuery = undefined;
        if (this.queries.active) this.client.cancelQuery(this.queries.active.requestId);
        this.queries.clear();
        if (this.exploreView) { this.view = this.exploreView; this.exploreView = undefined; }
        this.publish(); return;
      case 'branch': await this.changeBranch(message); return;
      case 'gitState':
        if (message.action === 'sourceControl') { await vscode.commands.executeCommand('workbench.view.scm'); return; }
        this.observeGit(); this.publish();
        if (message.action === 'impact') {
          const seeds = [...new Set(this.git?.rows.filter(row => row.indexedNodeId && (!message.repoId || row.repoId === message.repoId)).map(row => row.indexedNodeId!) ?? [])];
          if (!seeds.length) { this.error('Нет доступных индексированных файлов изменений. Удалённые и неизвестные файлы не означают нулевое влияние.'); return; }
          if (seeds.length > 200) { this.error('Для одного запроса доступны 200 исходных файлов. Выберите отдельный репозиторий.'); return; }
          await this.startQuery({ kind: 'impact', seeds, depth: 1, includeInferred: false, includeTypes: true }, this.git?.gitRevision);
        }
        return;
      case 'taskContext': await this.handleTaskContext(message); return;
      case 'diagnostics': await this.diagnostics(message.action); return;
      case 'rebuild': await this.rebuild(); return;
      case 'cancel':
        this.client.cancel(); this.running++;
        this.indexStale = true;
        this.invalidateQueries('analysisCancelled'); this.index = { ...this.index, version: { ...this.index.version, epoch: randomUUID() }, state: 'cancelled', reasonCodes: ['analysisCancelled'] };
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        this.status = 'Indexing cancelled. The displayed graph may be out of date.'; this.publish(); return;
      case 'setView': {
        const changedScope = scopeSignature(this.view.queryScope) !== scopeSignature(message.view.queryScope);
        // Individual depths have their own commands; stale toolbar messages cannot replace them.
        this.view = { ...message.view, queryScope: message.view.queryScope ? normalizeScope(message.view.queryScope) : undefined,
          presentationScope: message.view.presentationScope ? normalizeScope(message.view.presentationScope) : undefined,
          nodeDepths: this.view.nodeDepths, ...(this.queries.active ? { focusId: this.view.focusId, follow: false } : {}) };
        if (changedScope) {
          this.invalidateQueries('queryScopeChanged'); this.pendingRestoredQuery = undefined;
          if (this.exploreView) this.exploreView = { ...this.exploreView, queryScope: this.view.queryScope, presentationScope: this.view.presentationScope };
          this.status = this.view.queryScope ? 'Область аналитики Q изменена. Прежние результаты устарели; повторите запрос.' : 'Аналитика снова использует весь разрешённый индекс. Повторите запрос.';
        }
        if (this.view.follow) {
          const active = vscode.window.activeTextEditor?.document.uri;
          const id = active ? this.idForUri(active) : undefined;
          if (id && this.graph.nodes.some(node => node.id === id)) this.view.focusId = id;
        }
        this.publish(); return;
      }
      case 'focusFile':
        if (this.graph.nodes.some(node => node.id === message.nodeId)) { this.view.focusId = message.nodeId; this.view.mode = 'file'; this.publish(); }
        return;
      case 'setNodeDepth': {
        if (!this.graph.nodes.some(node => node.id === message.nodeId && node.file)) return;
        const depths = { ...this.view.nodeDepths };
        if (message.depth === null) delete depths[message.nodeId];
        else {
          if (!(message.nodeId in depths) && Object.keys(depths).length >= 200) {
            this.error('Достигнут предел 200 индивидуальных глубин. Сбросьте ненужные настройки.'); return;
          }
          depths[message.nodeId] = message.depth;
        }
        this.view = { ...this.view, nodeDepths: depths };
        this.publish(); return;
      }
      case 'resetNodeDepths':
        this.view = { ...this.view, nodeDepths: {} }; this.publish(); return;
      case 'openFile': await this.openNode(message.nodeId); return;
      case 'openEvidence': {
        const relation = this.graph.relations.find(edge => edge.id === message.relationId);
        if (!relation) return;
        const range = this.indexStale ? undefined : relation.evidence.find(item => item.range)?.range;
        await this.openNode(relation.sourceId, range?.start); return;
      }
      case 'openDeclaration': {
        if (this.view.queryScope) {
          const relation = this.graph.relations.find(edge => edge.id === message.relationId);
          if (!relation || !inScope(this.graph.nodes.find(node => node.id === relation.sourceId), this.view.queryScope)
            || !inScope(this.graph.nodes.find(node => node.id === relation.targetId), this.view.queryScope)) return;
          const imported = relation.bindings.find(binding => binding.imported === message.imported)?.resolvedImported ?? message.imported;
          const resolution = resolveExport(exportTables(scopedGraph(this.graph, this.view.queryScope)), relation.targetId, imported, 'both');
          const candidate = resolution.status === 'resolved' ? resolution.candidates[0] : undefined;
          const target = candidate && this.graph.nodes.find(node => node.id === candidate.fileId);
          if (target?.file) await this.openNode(target.id, this.indexStale ? undefined : candidate?.range?.start);
          else this.error('Объявление не разрешено внутри области Q; внешний barrel или ограничение анализа не обходятся.');
          return;
        }
        const declaration = this.graph.declarations?.find(item => item.relationId === message.relationId && item.imported === message.imported);
        if (declaration) await this.openNode(fileId(declaration.file), this.indexStale ? undefined : declaration.range.start);
        return;
      }
      case 'annotation':
        this.annotationQueue = this.annotationQueue.catch(() => {}).then(() => this.mutateAnnotations(message));
        await this.annotationQueue; return;
    }
  }

  private analytics(): AnalyticsState {
    return { index: this.index, runtime: this.runtime, active: this.queries.active, branches: this.branches, git: this.git, taskContexts: this.taskContexts, uiStateToken: this.uiStateToken };
  }

  private updateCompatibility(): void {
    const reasons: string[] = [];
    if (!this.runtime.webview) reasons.push('legacyWebview');
    else if (!compatibleBuild(this.runtime.webview)) reasons.push('webviewBuildMismatch');
    if (this.runtime.worker && !compatibleBuild(this.runtime.worker)) reasons.push('workerBuildMismatch');
    if (this.runtime.installedVersion !== buildInfo.extensionVersion) reasons.push('installedRunningVersionMismatch');
    this.runtime = { ...this.runtime, compatible: reasons.length === 0, reasonCodes: reasons };
    if (reasons.length) this.status = `Несовместимая или устаревшая карта: host ${buildInfo.extensionVersion}, Webview ${this.runtime.webview?.extensionVersion ?? 'legacy'}, пакет ${this.runtime.installedVersion}. Выполните Developer: Reload Window и откройте карту заново.`;
    else if (this.status.startsWith('Несовместимая или устаревшая карта:')) this.status = this.indexStale ? 'Индекс требует пересчёта.' : 'Индекс актуален.';
  }

  private invalidateQueries(reason: string): void {
    this.client.cancelQueries(); this.queries.invalidate(); this.branchRequests.clear();
    this.branches = this.branches.map(branch => ({ ...branch, result: branch.result ? { ...branch.result, freshness: 'stale', reasonCodes: [...new Set([...branch.result.reasonCodes, reason])] } : undefined }));
  }

  private async startQuery(query: QuerySpec, gitRevision?: number): Promise<void> {
    if (!this.runtime.compatible || !this.runtime.worker || !compatibleBuild(this.runtime.worker)) { this.error('Версии host, worker и карты должны совпадать. Перезагрузите окно и откройте карту.'); return; }
    const previousRequestId = this.queries.active?.requestId;
    const request = this.queries.start(query, this.index, this.graph, gitRevision, this.view.queryScope);
    if (!request) { this.error('Для запроса нужен актуальный индекс и существующие исходные файлы. Пересчитайте карту.'); return; }
    this.pendingRestoredQuery = undefined;
    if (previousRequestId) this.client.cancelQuery(previousRequestId);
    if (!this.exploreView) this.exploreView = { ...this.view };
    this.view = { ...this.view, follow: false };
    this.publish();
    const result = await this.client.query(request);
    if (this.disposed) return;
    if (result) this.queries.accept(result, this.index, this.git?.gitRevision, this.view.queryScope);
    else if (this.queries.active?.requestId === request.requestId && this.queries.active.state === 'running') this.queries.active = { ...this.queries.active, state: 'failed' };
    this.publish();
  }

  private async changeBranch(message: Extract<UiMessage, { type: 'branch' }>): Promise<void> {
    const existing = this.branches.find(branch => branch.anchorId === message.nodeId && branch.direction === message.direction);
    const id = existing?.id ?? `branch:${createHash('sha256').update(JSON.stringify([message.nodeId, message.direction])).digest('hex').slice(0, 24)}`;
    const pending = this.branchRequests.get(id); if (pending) this.client.cancelQuery(pending);
    if (message.action === 'collapse') { this.branches = this.branches.filter(branch => branch.id !== id); this.branchRequests.delete(id); this.publish(); return; }
    if (!this.runtime.compatible || this.index.state !== 'ready' || !this.graph.nodes.some(node => node.id === message.nodeId && node.file && inScope(node, this.view.queryScope))) { this.error('Раскрытие доступно для файлов актуального индекса внутри области Q.'); return; }
    if (!existing && this.branches.length >= 200) { this.error('Достигнут предел 200 раскрытых веток. Сверните ненужные ветки.'); return; }
    const branch: BranchIntent = { id, anchorId: message.nodeId, direction: message.direction, depth: Math.min(20, (existing?.depth ?? 0) + 1), result: existing?.result };
    this.view = { ...this.view, follow: false };
    this.branches = [...this.branches.filter(item => item.id !== id), branch]; this.publish();
    await this.runBranch(branch);
  }

  private async runBranch(branch: BranchIntent): Promise<void> {
    if (!this.runtime.compatible || !this.runtime.worker || !compatibleBuild(this.runtime.worker) || this.index.state !== 'ready' || !this.graph.nodes.some(node => node.id === branch.anchorId && node.file && inScope(node, this.view.queryScope))) return;
    const requestId = randomUUID(), version = { ...this.index.version };
    this.branchRequests.set(branch.id, requestId);
    const signature = scopeSignature(this.view.queryScope);
    const result = await this.client.query({ type: 'query', apiVersion: 1, requestId, graph: version, limits: queryLimits, scope: this.view.queryScope, queryScopeSignature: signature, query: { kind: 'neighbourhood', anchorId: branch.anchorId, direction: branch.direction, depth: branch.depth } });
    if (!result || this.disposed || this.index.state !== 'ready' || !sameIndex(result.graph, this.index.version) || this.branchRequests.get(branch.id) !== requestId
      || signature !== scopeSignature(this.view.queryScope) || result.queryScopeSignature !== signature) return;
    this.branchRequests.delete(branch.id);
    this.branches = this.branches.map(item => item.id === branch.id ? { ...item, result } : item); this.publish();
  }

  private observeGit(): void {
    const previous = this.git?.gitRevision;
    this.git = this.gitProvider.observe(this.roots, this.graph, vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' && document.isDirty).map(document => document.uri.fsPath), { exclude: vscode.workspace.getConfiguration('dependencyMap').get<string[]>('exclude', defaultExclude) });
    if (this.queries.active?.gitRevision !== undefined && previous !== this.git.gitRevision) {
      this.client.cancelQuery(this.queries.active.requestId); this.queries.invalidate();
    }
  }

  private contextStoreId(): string | undefined {
    const root = this.roots.find(root => this.annotationPath && sameFilePath(path.join(root.path, '.vscode', 'dependency-map.json'), this.annotationPath));
    return root ? `${root.id}:.vscode/dependency-map.json` : undefined;
  }

  private refreshTaskContexts(): void {
    const store = this.contextStoreId();
    try {
      const entries = store ? this.taskStore.list(store) : [];
      const groups = new Set(this.annotations?.groups.map(group => group.id) ?? []);
      this.taskContexts = { ...this.taskContexts, savedGroupIds: entries.filter(entry => groups.has(entry.groupId)).map(entry => entry.groupId), orphanedGroupIds: entries.filter(entry => !groups.has(entry.groupId)).map(entry => entry.groupId) };
    } catch { this.taskContexts = { ...this.taskContexts, message: 'Локальные контексты имеют неизвестную версию или повреждены. Данные сохранены без перезаписи.' }; }
  }

  private async handleTaskContext(message: Extract<UiMessage, { type: 'taskContext' }>): Promise<void> {
    const storeId = this.contextStoreId();
    if (!storeId) { this.taskContexts = { ...this.taskContexts, message: 'Сначала выберите существующую общую группу задачи.' }; this.publish(); return; }
    try {
      if (message.action === 'delete') {
        await this.taskStore.remove(storeId, message.groupId);
        this.taskContexts = { ...this.taskContexts, preview: undefined, restore: undefined, message: 'Локальная точка возврата удалена. Общая группа сохранена.' };
      } else if (message.action === 'save') {
        const group = this.annotations?.groups.find(group => group.id === message.groupId);
        if (!group || !message.data) throw new Error('Missing group/context');
        await this.taskStore.save(storeId, group.id, { ...message.data, view: { ...this.view }, query: this.queries.active?.query, branches: this.branches.map(({ result, ...intent }) => intent) }, fingerprintGroup(group));
        this.taskContexts = { ...this.taskContexts, preview: undefined, restore: undefined, message: 'Точка возврата сохранена только в этом workspace. Общий JSON не изменён.' };
      } else {
        await this.refreshAnnotations();
        const saved = this.taskStore.load(storeId, message.groupId);
        if (!saved) throw new Error('Context missing');
        const group = this.annotations?.groups.find(group => group.id === message.groupId);
        const preview = previewTaskContext(saved, this.graph, fingerprintGroup(group), !group);
        if (this.annotationError) preview.reasonCodes.push('sharedAnnotationsUnavailable');
        const guard = JSON.stringify([storeId, message.groupId, fingerprintGroup(group), this.index.version, this.annotationError]);
        if (message.action === 'preview' || !this.taskContexts.preview || this.taskPreviewGuard !== guard) {
          this.taskPreviewGuard = guard;
          this.taskContexts = { ...this.taskContexts, preview, restore: undefined, message: message.action === 'restore' ? 'Данные изменились. Проверьте обновлённый предпросмотр и повторите восстановление.' : 'Проверьте доступные ссылки перед восстановлением.' };
        } else {
          await this.context.workspaceState.update('dependencyMap.uiState.v2', preview.data.ui);
          this.uiStateToken = randomUUID();
          if (this.queries.active) this.client.cancelQuery(this.queries.active.requestId);
          this.client.cancelQueries(); this.queries.clear(); this.exploreView = undefined;
          this.pendingRestoredQuery = undefined;
          this.view = { ...preview.data.view, follow: false };
          this.branches = preview.data.branches;
          this.taskContexts = { ...this.taskContexts, preview: undefined, restore: { token: this.uiStateToken, data: preview.data }, message: 'Доступный контекст восстановлен; следование приостановлено. Недоступные ссылки сохранены.' };
          this.publish();
          for (const branch of this.branches) void this.runBranch(branch);
          if (preview.data.query) {
            if (this.index.state === 'ready' && querySeeds(preview.data.query).every(id => this.graph.nodes.some(node => node.id === id && node.file))) void this.startQuery(preview.data.query);
            else { this.queries.active = { requestId: randomUUID(), query: preview.data.query, state: 'stale' }; this.pendingRestoredQuery = preview.data.query; }
          }
        }
      }
      this.refreshTaskContexts(); this.publish();
    } catch { this.taskContexts = { ...this.taskContexts, message: 'Контекст не изменён: проверьте версию, доступность группы и лимит локального хранилища.' }; this.publish(); }
  }

  async diagnostics(action: 'preview' | 'copy' | 'reload' = 'preview'): Promise<void> {
    if (action === 'reload') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return; }
    if (action === 'preview') {
      this.diagnosticPreview = formatDiagnostics({ runtime: this.runtime, index: this.index, graph: this.graph, git: this.git, active: this.queries.active });
      if (this.panel.isReady()) this.panel.diagnostics(this.diagnosticPreview);
      else {
        const document = await vscode.workspace.openTextDocument({ language: 'json', content: this.diagnosticPreview });
        await vscode.window.showTextDocument(document, { preview: true });
      }
    } else if (this.diagnosticPreview !== undefined) { await vscode.env.clipboard.writeText(this.diagnosticPreview); }
  }

  private async openNode(id: string, position?: { line: number; character: number }): Promise<void> {
    const node = this.graph.nodes.find(item => item.id === id);
    if (!node?.file) return;
    try {
      const uri = vscode.Uri.file(await resolveAllowedFile(node.file, this.roots));
      if (['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.wasm', '.pdf'].includes(node.format) && !position) {
        await vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.One);
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const start = position ? document.validatePosition(new vscode.Position(position.line, position.character)) : undefined;
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: true, ...(start ? { selection: new vscode.Range(start, start) } : {}) });
    } catch { this.error('This file is missing or outside the indexed workspace. Rebuild the index to refresh it.'); }
  }

  private relationRef(id: string): RelationRef | undefined {
    const edge = this.graph.relations.find(item => item.id === id);
    if (!edge) return;
    const source = this.graph.nodes.find(node => node.id === edge.sourceId);
    const target = this.graph.nodes.find(node => node.id === edge.targetId);
    if (!source?.file || !target) return;
    const endpoint = target.file ?? (target.packageName ? { packageName: target.packageName, projectId: target.projectId } : undefined);
    if (!endpoint) return;
    return { source: source.file, target: endpoint, kind: edge.kind, ...(edge.specifier === undefined ? {} : { specifier: edge.specifier }) };
  }

  private async selectAnnotationStore(): Promise<boolean> {
    if (this.annotationStore) return true;
    const root = this.roots.length === 1 ? this.roots[0] : await vscode.window.showQuickPick(this.roots.map(item => ({ label: item.name, description: item.path, root: item })), { placeHolder: 'Choose the root for shared task groups' }).then(item => item?.root);
    if (!root) return false;
    this.annotationPath = path.join(root.path, '.vscode', 'dependency-map.json');
    await this.validateAnnotationLocation(this.annotationPath);
    this.annotationStore = new AnnotationStore(this.annotationPath);
    this.annotations = await this.annotationStore.load();
    await this.context.workspaceState.update('dependencyMap.annotationPath', this.annotationPath);
    return true;
  }

  private async mutateAnnotations(message: Extract<UiMessage, { type: 'annotation' }>): Promise<void> {
    const reply = (ok: boolean, text: string, groupId?: string, files = 0, relations = 0, skipped = 0) => {
      if (message.requestId !== undefined) this.panel.annotationResult({ type: 'annotationResult', requestId: message.requestId, action: message.action, ok, message: text, groupId, files, relations, skipped });
    };
    try {
      if (!await this.selectAnnotationStore() || !this.annotationStore || !this.annotationPath) { reply(false, 'Выбор файла общих групп отменён.'); return; }
      if (vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && sameFilePath(document.uri.fsPath, this.annotationPath!) && document.isDirty)) {
        this.annotationError = 'Save or close unsaved changes to dependency-map.json before changing groups.'; this.publish(); reply(false, this.annotationError); return;
      }
      await this.validateAnnotationLocation(this.annotationPath);
      const current = await this.annotationStore.load() ?? createAnnotations(this.roots);
      for (const root of this.roots) if (!current.roots.some(item => item.id === root.id)) current.roots.push({ id: root.id, label: root.name });
      const nodeIds = [...new Set(message.nodeIds ?? [])];
      const relationIds = [...new Set(message.relationIds ?? [])];
      const nodes = nodeIds.map(id => this.graph.nodes.find(node => node.id === id)).filter((node): node is GraphNode => !!node?.file);
      let files = nodes.map(node => node.file!);
      if (message.action === 'markFolder') {
        files = this.graph.nodes.filter(node => node.file && nodes.some(selected => node.file!.rootId === selected.file!.rootId && (path.posix.dirname(selected.file!.path) === '.' || node.file!.path.startsWith(`${path.posix.dirname(selected.file!.path)}/`)))).map(node => node.file!);
      }
      const relations = relationIds.map(id => this.relationRef(id)).filter((ref): ref is RelationRef => !!ref);
      const skipped = nodeIds.length - nodes.length + relationIds.length - relations.length;
      const creates = message.action === 'createGroup' || message.action === 'createGroupAndMark';
      const targets = !['createGroup', 'updateGroup', 'deleteGroup'].includes(message.action);
      if (targets && !files.length && !relations.length) { reply(false, 'Выберите существующие файлы или связи. Устаревшие элементы не изменены.', message.groupId, 0, 0, skipped); return; }
      const groupId = creates ? randomUUID() : message.groupId;
      let mutation: AnnotationMutation;
      if (creates) {
        if (!message.name || !message.color) throw new Error('Group name and color are required.');
        mutation = message.action === 'createGroupAndMark'
          ? { action: 'createGroupAndMark', groupId, name: message.name, color: message.color, files, relations, note: message.note }
          : { action: 'createGroup', groupId, name: message.name, color: message.color };
      } else {
        if (!groupId) throw new Error('Choose a group.');
        if (message.action === 'deleteGroup') mutation = { action: 'deleteGroup', groupId };
        else if (message.action === 'updateGroup') mutation = { action: 'updateGroup', groupId, name: message.name, color: message.color };
        else mutation = { action: message.action === 'markFolder' ? 'mark' : message.action as 'mark' | 'unmark' | 'note', groupId, files, relations, note: message.note };
      }
      const updated = applyAnnotationMutation(current, mutation);
      await this.validateAnnotationLocation(this.annotationPath);
      await this.annotationStore.save(updated);
      this.annotations = updated;
      this.refreshTaskContexts();
      this.annotationError = undefined;
      if (creates) this.view.activeGroupId = groupId;
      this.publish();
      reply(true, targets ? `Сохранено: ${files.length} файлов, ${relations.length} связей.${skipped ? ` Пропущено: ${skipped}.` : ''}` : message.action === 'deleteGroup' ? 'Группа удалена.' : 'Свойства группы сохранены.', groupId, targets ? files.length : 0, targets ? relations.length : 0, skipped);
    } catch { this.annotationError = 'Could not save groups: invalid file, conflicting changes or a write error. The existing file has been preserved.'; this.publish(); reply(false, this.annotationError); }
  }

  private async refreshAnnotations(): Promise<void> {
    if (!this.annotationStore) return;
    try { if (this.annotationPath) await this.validateAnnotationLocation(this.annotationPath); this.annotations = await this.annotationStore.load(); this.annotationError = undefined; }
    catch { this.annotationError = 'Shared annotation file is invalid or unreadable. The last valid marks are displayed.'; }
    this.refreshTaskContexts(); this.publish();
  }

  private async validateAnnotationLocation(file: string): Promise<void> {
    const root = this.roots.find(item => sameFilePath(path.join(item.path, '.vscode', 'dependency-map.json'), file));
    if (!root) throw new Error('Annotations must belong to an open workspace root.');
    const expected = await realpath(root.path);
    let actual: string;
    try { actual = await realpath(path.dirname(file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; actual = expected; }
    const relative = path.relative(expected, actual);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || relative.split(path.sep).includes('node_modules')) throw new Error('Annotations directory escapes the workspace.');
  }

  private publish(): void {
    if (this.disposed) return;
    this.panel.update({ type: 'state', graph: this.graph, view: this.view, status: this.status, annotations: this.annotations, annotationError: this.annotationError, analytics: this.analytics() });
    const view = JSON.stringify(this.view);
    if (view !== this.savedView && this.canSaveView) { this.savedView = view; void this.context.workspaceState.update('dependencyMap.view.v2', this.view); }
  }

  private localState(): unknown { return this.context.workspaceState.get('dependencyMap.uiState.v2') ?? this.context.workspaceState.get('dependencyMap.uiState'); }

  private error(message: string): void { this.status = message; this.publish(); }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.client.dispose(); this.panel.dispose();
    this.gitProvider.dispose();
    for (const item of [...this.subscriptions, ...this.watchers]) item.dispose();
  }
}
