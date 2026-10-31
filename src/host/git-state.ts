import path from 'node:path';
import { createHash } from 'node:crypto';
import { minimatch } from 'minimatch';
import { fileId, type FileRef, type GraphSnapshot, type WorkspaceRoot } from '../shared/model';
import type { GitChangeRow, GitStatusSnapshot } from '../shared/query-model';

interface Disposable { dispose(): void }
type CachedEvent = (listener: () => void) => Disposable;
interface CachedUri { scheme: string; fsPath: string }
export interface CachedGitChange { uri: CachedUri; originalUri?: CachedUri; renameUri?: CachedUri; status: number }
export interface CachedGitRepository {
  rootUri: CachedUri;
  state: { indexChanges: CachedGitChange[]; workingTreeChanges: CachedGitChange[]; mergeChanges: CachedGitChange[]; untrackedChanges?: CachedGitChange[]; onDidChange?: CachedEvent };
}
export interface CachedGitApi {
  repositories: CachedGitRepository[]; state?: 'uninitialized' | 'initialized'; onDidOpenRepository?: CachedEvent; onDidCloseRepository?: CachedEvent; onDidChangeState?: CachedEvent;
}
export interface CachedGitExtension {
  isActive: boolean;
  exports: { enabled: boolean; getAPI(version: 1): CachedGitApi; onDidChangeEnablement?: CachedEvent };
}
export interface GitObserveOptions { exclude?: string[]; physicalNodeIds?: ReadonlySet<string>; maxRows?: number }

const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (parent: string, child: string) => { const relative = path.relative(canonical(parent), canonical(child)); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const opaqueId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const forbiddenPart = (part: string) => ['node_modules', '.git'].includes(process.platform === 'win32' ? part.toLowerCase() : part);

function mapPath(value: CachedUri | undefined, roots: WorkspaceRoot[], exclude: string[]): FileRef | undefined {
  if (!value || value.scheme !== 'file' || typeof value.fsPath !== 'string') return undefined;
  if (value.fsPath.length > 32768 || value.fsPath.split(/[\\/]/).some(forbiddenPart)) return undefined;
  const root = [...roots].sort((a, b) => b.path.length - a.path.length).find(root => within(root.path, value.fsPath));
  if (!root) return undefined;
  const relative = path.relative(root.path, value.fsPath).split(path.sep).join('/');
  if (!relative || relative.split('/').some(part => !part || part === '..' || part === '.' || forbiddenPart(part)) || /[\u0000-\u001f]/.test(relative)) return undefined;
  if (exclude.some(pattern => relative.split('/').includes(pattern) || minimatch(relative, pattern, { dot: true }) || minimatch(relative, `${pattern}/**`, { dot: true }))) return undefined;
  return { rootId: root.id, path: relative };
}

/** Reads the already-active Git API cache; never activates Git, refreshes it, or reads files. */
export class PassiveGitState {
  private subscriptions: Disposable[] = [];
  private watching = false;
  private revision = 0;
  private signature = '';
  private disposed = false;
  constructor(private readonly readExtension: () => CachedGitExtension | undefined, private readonly onChange: () => void = () => {}, private readonly clock: () => number = Date.now) {}

  observe(roots: WorkspaceRoot[], graph: GraphSnapshot, dirtyPaths: string[] = [], options: GitObserveOptions = {}): GitStatusSnapshot {
    const result: GitStatusSnapshot = { gitRevision: this.revision, providerState: 'unavailable', observedAt: this.clock(), repositories: [], rows: [], omissions: 0, reasonCodes: ['cachedProviderState'] };
    const maxRows = Math.max(1, Math.min(10000, Number.isSafeInteger(options.maxRows) ? options.maxRows! : 10000));
    const excluded = options.exclude ?? [];
    const physical = options.physicalNodeIds ?? new Set(graph.physicalFileIds ?? []);
    const nodes = new Set(graph.nodes.filter(node => node.file).map(node => node.id));
    const rootPaths = new Map(roots.map(root => [root.id, root.path]));
    const indexedPaths = new Map(graph.nodes.flatMap(node => {
      const rootPath = node.file && rootPaths.get(node.file.rootId);
      return rootPath && node.file ? [[canonical(path.join(rootPath, node.file.path)), node.file] as const] : [];
    }));
    const rows = new Map<string, GitChangeRow>();
    let examined = 0;
    const dirty = new Set(dirtyPaths.map(canonical));
    try {
      const extension = this.readExtension();
      if (!extension) result.reasonCodes.push('providerMissing');
      else if (!extension.isActive) { result.providerState = 'inactive'; result.reasonCodes.push('providerInactive'); }
      else if (!extension.exports.enabled) { result.providerState = 'disabled'; result.reasonCodes.push('providerDisabled'); }
      else {
        const api = extension.exports.getAPI(1);
        if (!api || !Array.isArray(api.repositories)) throw new Error('Unsupported cached Git API');
        result.providerState = api.state === 'uninitialized' ? 'unavailable' : 'available';
        if (api.state === 'uninitialized') result.reasonCodes.push('providerUninitialized');
        for (const repository of api.state === 'uninitialized' ? [] : api.repositories) {
          let repoId: string | undefined;
          try {
            const rootUri = repository.rootUri;
            if (rootUri.scheme !== 'file' || !roots.some(root => within(rootUri.fsPath, root.path) || within(root.path, rootUri.fsPath))) continue;
            repoId = `repo:${opaqueId(canonical(rootUri.fsPath))}`;
            const state = repository.state;
            const summary = { id: repoId, label: `Git ${result.repositories.length + 1}`, state: 'available' as 'available' | 'failed' };
            result.repositories.push(summary);
            const streams = [
              { values: state.indexChanges, staged: true, unstaged: false, conflict: false },
              { values: state.workingTreeChanges, staged: false, unstaged: true, conflict: false },
              { values: state.mergeChanges, staged: false, unstaged: true, conflict: true },
              { values: state.untrackedChanges ?? [], staged: false, unstaged: true, conflict: false },
            ];
            for (const stream of streams) {
              if (!Array.isArray(stream.values)) throw new Error('Unsupported cached Git repository');
              for (let offset = 0; offset < stream.values.length; offset++) {
                if (examined >= maxRows) { result.omissions += stream.values.length - offset; result.reasonCodes.push('rowLimit'); break; }
                examined++;
                const change = stream.values[offset];
                if (!change || change.status === 8) continue;
                const scoped = mapPath(change.uri, roots, excluded);
                if (!scoped || !within(rootUri.fsPath, change.uri.fsPath)) { result.omissions++; continue; }
                const file = indexedPaths.get(canonical(change.uri.fsPath)) ?? scoped;
                const nodeId = fileId(file);
                if (change.status === 7 && !physical.has(nodeId)) { result.omissions++; result.reasonCodes.push('untrackedNotInPhysicalInventory'); continue; }
                const key = `${repoId}:${nodeId}`;
                const deleted = [2, 6, 14, 15, 17].includes(change.status);
                const row = rows.get(key) ?? { id: `change:${opaqueId(key)}`, repoId, relativePath: file.path, file, staged: false, unstaged: false, untracked: false, conflict: false, dirty: false, scopeStatus: 'unindexed' as const };
                row.staged ||= stream.staged; row.unstaged ||= stream.unstaged; row.untracked ||= change.status === 7;
                row.conflict ||= stream.conflict || change.status >= 12 && change.status <= 18;
                row.dirty ||= dirty.has(canonical(change.uri.fsPath));
                const original = [3, 4, 10].includes(change.status) ? mapPath(change.originalUri, roots, excluded) : undefined;
                if (original && (original.rootId !== file.rootId || original.path !== file.path)) { row.originalRelativePath = original.path; row.originalFile = original; }
                if (deleted) { row.scopeStatus = 'deleted'; row.indexedNodeId = undefined; }
                else if (row.scopeStatus !== 'deleted' && nodes.has(nodeId)) { row.scopeStatus = 'indexed'; row.indexedNodeId = nodeId; }
                rows.set(key, row);
              }
            }
          } catch {
            if (repoId) {
              const summary = result.repositories.find(repo => repo.id === repoId);
              if (summary) summary.state = 'failed';
              else result.repositories.push({ id: repoId, label: `Git ${result.repositories.length + 1}`, state: 'failed' });
            }
            result.reasonCodes.push('repositoryReadFailed');
          }
        }
      }
    } catch { result.providerState = 'failed'; result.reasonCodes.push('providerReadFailed'); }
    // Dirty buffers are a separate source, including buffers absent from cached Git metadata.
    const existingFiles = new Set([...rows.values()].flatMap(row => row.file ? [fileId(row.file)] : []));
    for (const dirtyPath of dirtyPaths) {
      const scoped = mapPath({ scheme: 'file', fsPath: dirtyPath }, roots, excluded);
      if (!scoped) continue;
      const file = indexedPaths.get(canonical(dirtyPath)) ?? scoped;
      const id = fileId(file);
      if (existingFiles.has(id)) continue;
      if (rows.size >= maxRows) { result.omissions++; result.reasonCodes.push('rowLimit'); continue; }
      const repoId = 'editor';
      rows.set(`editor:${id}`, { id: `buffer:${opaqueId(id)}`, repoId, relativePath: file.path, file, staged: false, unstaged: false, untracked: false, conflict: false, dirty: true, ...(nodes.has(id) ? { indexedNodeId: id } : {}), scopeStatus: 'bufferOnly' });
      existingFiles.add(id);
    }
    result.rows = [...rows.values()].sort((a, b) => a.repoId.localeCompare(b.repoId) || a.relativePath.localeCompare(b.relativePath));
    result.reasonCodes = [...new Set(result.reasonCodes)].sort();
    const signature = JSON.stringify({ ...result, gitRevision: 0, observedAt: 0 });
    if (signature !== this.signature) { this.signature = signature; this.revision++; }
    result.gitRevision = this.revision;
    return result;
  }

  watch(): void {
    if (this.disposed) return;
    this.watching = true;
    this.rebind();
  }

  private rebind(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    if (!this.watching || this.disposed) return;
    const changed = () => { this.rebind(); this.onChange(); };
    const subscribe = (event?: CachedEvent) => { if (typeof event === 'function') this.subscriptions.push(event(changed)); };
    try {
      const extension = this.readExtension();
      if (!extension?.isActive) return;
      subscribe(extension.exports.onDidChangeEnablement);
      if (!extension.exports.enabled) return;
      const api = extension.exports.getAPI(1);
      subscribe(api.onDidOpenRepository); subscribe(api.onDidCloseRepository); subscribe(api.onDidChangeState);
      for (const repository of api.repositories) { try { subscribe(repository.state.onDidChange); } catch { /* Observe reports this repository's failure. */ } }
    } catch { /* Observe reports unavailable or failed providers without provider error text. */ }
  }

  stop(): void { this.watching = false; for (const subscription of this.subscriptions) subscription.dispose(); this.subscriptions = []; }
  dispose(): void { this.stop(); this.disposed = true; }
}
