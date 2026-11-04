import { createHash } from 'node:crypto';
import { isSavedUiState, isViewState } from '../shared/protocol';
import { isQuerySpec, querySeeds, type SavedTaskContext, type TaskContextData, type TaskContextPreview } from '../shared/query-model';
import type { GraphSnapshot } from '../shared/model';

interface Memento { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
interface LocalContexts { version: 1; contexts: SavedTaskContext[] }
export const taskContextStoreKey = 'dependencyMap.taskContexts.v2';
const maxContexts = 100;
const maxContextBytes = 2 * 1024 * 1024;
const maxStoreBytes = 20 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max = 20000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const portableText = (value: unknown, max = 20000): value is string => text(value, max) && !/(?:^|["\s,:])(?:[a-z]:[\\/]|\/\/|\/[^/])|\\/i.test(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fileToken(value: unknown): boolean {
  if (!text(value) || !value.startsWith('file:')) return false;
  const delimiter = value.indexOf(':', 5);
  if (delimiter < 6) return false;
  const root = value.slice(5, delimiter), relative = value.slice(delimiter + 1);
  try { if (!text(decodeURIComponent(root), 200) || /[\s/\\:]/.test(decodeURIComponent(root))) return false; } catch { return false; }
  return relative.length > 0 && !/[\\:\u0000-\u001f]/.test(relative) && !relative.startsWith('/')
    && !relative.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.toLowerCase() === 'node_modules');
}
function nodeToken(value: unknown): boolean {
  return fileToken(value) || portableText(value) && value.startsWith('external:');
}
function relationToken(value: unknown): boolean {
  if (!text(value)) return false;
  try {
    const entry: unknown = JSON.parse(value);
    return Array.isArray(entry) && entry.length === 4 && fileToken(entry[0]) && nodeToken(entry[1])
      && ['import', 'reexport', 'resource', 'config', 'framework', 'environment'].includes(entry[2])
      && (entry[3] === '' || portableText(entry[3], 4096));
  } catch { return false; }
}
function list(value: unknown, check: (entry: unknown) => boolean, cap: number): value is string[] {
  return Array.isArray(value) && value.length <= cap && value.every(check);
}

/** Validates only local view/intent data; query results and source payloads have no persisted fields. */
export function isTaskContextData(value: unknown): value is TaskContextData {
  if (!object(value) || !fields(value, ['view', 'ui', 'query', 'branches', 'selection']) || !isViewState(value.view) || !isSavedUiState(value.ui)) return false;
  if (value.view.focusId !== undefined && !nodeToken(value.view.focusId)) return false;
  if (Object.keys(value.view.nodeDepths ?? {}).some(key => !fileToken(key))) return false;
  if (value.query !== undefined && (!isQuerySpec(value.query) || !querySeeds(value.query).every(fileToken))) return false;
  if (!Array.isArray(value.branches) || value.branches.length > 200 || !value.branches.every(branch => object(branch)
    && fields(branch, ['id', 'anchorId', 'direction', 'depth']) && text(branch.id) && fileToken(branch.anchorId)
    && ['incoming', 'outgoing'].includes(String(branch.direction)) && Number.isInteger(branch.depth) && Number(branch.depth) >= 1 && Number(branch.depth) <= 20)) return false;
  if (new Set(value.branches.map(branch => branch.id)).size !== value.branches.length) return false;
  if (!object(value.selection) || !fields(value.selection, ['nodeIds', 'relationIds'])
    || !list(value.selection.nodeIds, nodeToken, 10000) || !list(value.selection.relationIds, relationToken, 20000)) return false;
  const ui = value.ui;
  const positions = ui.canvas?.positions;
  if (positions && Object.keys(positions).some(key => !nodeToken(key) && !(portableText(key) && key.startsWith('group:')))) return false;
  // A context should not turn an accidentally pasted machine path into persisted navigation data.
  if (['query', 'project', 'folder'].some(key => {
    const field = ui[key as 'query' | 'project' | 'folder'];
    return field !== undefined && field !== '' && !portableText(field, 4096);
  })) return false;
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxContextBytes;
}

function validSaved(value: unknown): value is SavedTaskContext {
  return object(value) && fields(value, ['version', 'storeId', 'groupId', 'savedAt', 'groupFingerprint', 'data']) && value.version === 1
    && portableText(value.storeId, 4096) && text(value.groupId, 200) && Number.isSafeInteger(value.savedAt) && Number(value.savedAt) >= 0
    && text(value.groupFingerprint, 1024) && isTaskContextData(value.data);
}

export function fingerprintGroup(group: unknown): string {
  return createHash('sha256').update(JSON.stringify(group ?? null)).digest('hex');
}

export class LocalTaskContextStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly memento: Memento, private readonly clock: () => number = Date.now) {}

  private read(): LocalContexts {
    const value = this.memento.get<unknown>(taskContextStoreKey) ?? this.memento.get<unknown>('dependencyMap.taskContexts.v1');
    if (value === undefined) return { version: 1, contexts: [] };
    if (!object(value) || value.version !== 1) throw new Error('Unsupported local task context version. Existing data preserved.');
    if (!fields(value, ['version', 'contexts']) || !Array.isArray(value.contexts) || value.contexts.length > maxContexts || !value.contexts.every(validSaved)) throw new Error('Invalid local task contexts. Existing data preserved.');
    const keys = value.contexts.map(item => JSON.stringify([item.storeId, item.groupId]));
    if (new Set(keys).size !== keys.length || Buffer.byteLength(JSON.stringify(value), 'utf8') > maxStoreBytes) throw new Error('Invalid local task context store. Existing data preserved.');
    return clone(value as unknown as LocalContexts);
  }

  list(storeId: string): SavedTaskContext[] { return this.read().contexts.filter(item => item.storeId === storeId); }
  load(storeId: string, groupId: string): SavedTaskContext | undefined { return this.list(storeId).find(item => item.groupId === groupId); }

  save(storeId: string, groupId: string, data: TaskContextData, groupFingerprint: string): Promise<SavedTaskContext> {
    const entry: SavedTaskContext = { version: 1, storeId, groupId, savedAt: this.clock(), groupFingerprint, data };
    if (!validSaved(entry)) return Promise.reject(new Error('Invalid local task context data.'));
    const saved = clone(entry);
    const work = this.pending.catch(() => {}).then(async () => {
      const current = this.read();
      const index = current.contexts.findIndex(item => item.storeId === storeId && item.groupId === groupId);
      if (index < 0 && current.contexts.length >= maxContexts) throw new Error('Local context limit reached (100). Delete an old context explicitly.');
      if (index < 0) current.contexts.push(saved); else current.contexts[index] = saved;
      if (Buffer.byteLength(JSON.stringify(current), 'utf8') > maxStoreBytes) throw new Error('Local context storage limit reached. Delete a context explicitly.');
      await this.memento.update(taskContextStoreKey, current);
      return clone(saved);
    });
    this.pending = work.then(() => {}, () => {});
    return work;
  }

  remove(storeId: string, groupId: string): Promise<void> {
    const work = this.pending.catch(() => {}).then(async () => {
      const current = this.read();
      const contexts = current.contexts.filter(item => item.storeId !== storeId || item.groupId !== groupId);
      if (contexts.length !== current.contexts.length) await this.memento.update(taskContextStoreKey, { version: 1, contexts });
    });
    this.pending = work.catch(() => {});
    return work;
  }
}

export function previewTaskContext(saved: SavedTaskContext, graph: GraphSnapshot, currentGroupFingerprint?: string, groupMissing = false): TaskContextPreview {
  if (!validSaved(saved)) throw new Error('Invalid local task context.');
  const data = clone(saved.data);
  const nodes = new Set(graph.nodes.map(node => node.id));
  const relations = new Set(graph.relations.map(edge => edge.id));
  const referenced = new Set([
    ...data.selection.nodeIds, ...(data.view.focusId ? [data.view.focusId] : []),
    ...Object.keys(data.view.nodeDepths ?? {}), ...data.branches.map(branch => branch.anchorId),
    ...(data.query ? querySeeds(data.query) : []), ...Object.keys(data.ui.canvas?.positions ?? {}).filter(nodeToken),
  ]);
  const missingNodeIds = [...referenced].filter(id => !nodes.has(id)).sort();
  const reasonCodes: string[] = [];
  const roots = new Set(graph.nodes.flatMap(node => node.file ? [node.file.rootId] : []));
  if ([data.view.queryScope, data.view.presentationScope].some(scope => scope?.folders.some(folder => !roots.has(folder.rootId)))) reasonCodes.push('scopeRootUnavailable');
  const groupChanged = currentGroupFingerprint !== undefined && currentGroupFingerprint !== saved.groupFingerprint;
  if (missingNodeIds.length) reasonCodes.push('missingReferences');
  if (data.selection.relationIds.some(id => !relations.has(id))) reasonCodes.push('missingRelations');
  if (groupChanged) reasonCodes.push('groupChanged');
  if (groupMissing) reasonCodes.push('groupMissing');
  if (data.view.follow) reasonCodes.push('followPaused');
  data.view.follow = false;
  return { groupId: saved.groupId, savedAt: saved.savedAt, missingNodeIds, groupChanged, groupMissing, reasonCodes, data };
}
