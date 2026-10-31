import * as vscode from 'vscode';
import path from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AnalysisClient } from './analysis-client';
import { MapPanel } from './map-panel';
import { resolveAllowedFile, sameFilePath } from './navigation';
import { applyRootBindings } from './root-bindings';
import { extractEnvironmentKeys, isEnvironmentFile } from './environment';
import { AnnotationStore, applyAnnotationMutation, createAnnotations, type AnnotationMutation, type AnnotationsDocument, type RelationRef } from './annotations';
import { emptyGraph, fileId, initialView, type GraphNode, type GraphSnapshot, type SourceOverlay, type ViewState, type WorkspaceRoot } from '../shared/model';
import { isViewState, type UiMessage } from '../shared/protocol';

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

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<unknown>('dependencyMap.view');
    this.view = isViewState(saved) ? saved : initialView();
    this.client = new AnalysisClient(path.join(context.extensionPath, 'dist', 'worker.cjs'));
    this.panel = new MapPanel(context.extensionUri, message => { void this.handle(message).catch(() => this.error('The requested action could not be completed.')); }, () => this.context.workspaceState.get('dependencyMap.uiState'));
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
        this.initialized = undefined;
        void this.initialize().then(() => { if (this.opened) return this.rebuild(); });
      }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dependencyMap')) this.schedule(); })
    );
  }

  private initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.initializeWorkspace();
    return this.initialized;
  }

  private async initializeWorkspace(): Promise<void> {
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
    const bindings: Record<string, string> = {};
    for (const root of this.roots) bindings[vscode.Uri.file(root.path).toString()] = root.id;
    await this.context.workspaceState.update('dependencyMap.rootBindings', bindings);
    this.annotationError = undefined;
    await this.rebuild();
  }

  inspect() {
    return { type: 'state' as const, graph: this.graph, view: this.view, status: this.status, roots: this.roots, annotations: this.annotations, annotationError: this.annotationError, localState: this.context.workspaceState.get('dependencyMap.uiState'), panelReady: this.panel.isReady() };
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
    const segments = uri.fsPath.split(/[\\/]/);
    const excluded = vscode.workspace.getConfiguration('dependencyMap').get<string[]>('exclude', defaultExclude);
    if (segments.some(segment => segment === 'node_modules' || excluded.includes(segment))) return;
    if (this.idForUri(uri)) this.schedule();
    if (this.idForUri(uri)) this.changedPaths.add(uri.fsPath);
  }

  private schedule(): void {
    if (!this.opened || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.client.cancel();
    this.running++;
    this.status = 'Workspace changed; index is out of date.';
    this.indexStale = true;
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
    this.status = 'Indexing workspace…';
    this.publish();
    const overlays: SourceOverlay[] = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' && this.idForUri(document.uri) && !document.uri.fsPath.split(/[\\/]/).some(part => part.toLowerCase() === 'node_modules')).map(document => ({
      path: document.uri.fsPath, version: document.version,
      ...(isEnvironmentFile(document.uri.fsPath) ? { envKeys: extractEnvironmentKeys(document.getText()) } : { text: document.getText() })
    }));
    try {
      const graph = await this.client.analyze({ roots: this.roots, options: { exclude: vscode.workspace.getConfiguration('dependencyMap').get<string[]>('exclude', defaultExclude) }, overlays, ...(full ? {} : { changedPaths: [...this.changedPaths] }) }, message => {
        if (run === this.running) { this.status = message; this.publish(); }
      });
      if (run !== this.running || !graph || this.disposed) return;
      this.graph = graph;
      this.changedPaths.clear();
      this.indexStale = false;
      if (this.view.follow && vscode.window.activeTextEditor) {
        const active = this.idForUri(vscode.window.activeTextEditor.document.uri);
        if (active && graph.nodes.some(node => node.id === active)) this.view.focusId = active;
      }
      this.status = `${graph.stats.files} files · ${graph.relations.length} relations · ${graph.unresolved.length} unresolved · ${Math.round(graph.stats.elapsedMs)} ms`;
      this.publish();
    } catch { if (run === this.running) this.error('Indexing failed. The previous graph is preserved; use Rebuild to retry.'); }
  }

  private async handle(message: UiMessage): Promise<void> {
    switch (message.type) {
      case 'saveLocalState': await this.context.workspaceState.update('dependencyMap.uiState', message.state); return;
      case 'ready': this.publish(); return;
      case 'rebuild': await this.rebuild(); return;
      case 'cancel':
        this.client.cancel(); this.running++;
        this.indexStale = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        this.status = 'Indexing cancelled. The displayed graph may be out of date.'; this.publish(); return;
      case 'setView':
        // Individual depths have their own commands; stale toolbar messages cannot replace them.
        this.view = { ...message.view, nodeDepths: this.view.nodeDepths };
        if (this.view.follow) {
          const active = vscode.window.activeTextEditor?.document.uri;
          const id = active ? this.idForUri(active) : undefined;
          if (id && this.graph.nodes.some(node => node.id === id)) this.view.focusId = id;
        }
        this.publish(); return;
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
        const declaration = this.graph.declarations?.find(item => item.relationId === message.relationId && item.imported === message.imported);
        if (declaration) await this.openNode(fileId(declaration.file), this.indexStale ? undefined : declaration.range.start);
        return;
      }
      case 'annotation':
        this.annotationQueue = this.annotationQueue.catch(() => {}).then(() => this.mutateAnnotations(message));
        await this.annotationQueue; return;
    }
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
    this.publish();
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
    this.panel.update({ type: 'state', graph: this.graph, view: this.view, status: this.status, annotations: this.annotations, annotationError: this.annotationError });
    const view = JSON.stringify(this.view);
    if (view !== this.savedView) { this.savedView = view; void this.context.workspaceState.update('dependencyMap.view', this.view); }
  }

  private error(message: string): void { this.status = message; this.publish(); }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.client.dispose(); this.panel.dispose();
    for (const item of [...this.subscriptions, ...this.watchers]) item.dispose();
  }
}
