import type { FileRef, GraphSnapshot, RelationKind, SourceRange, ViewState } from './model';
import type { SavedUiState } from './protocol';

export interface IndexVersion { epoch: string; revision: number; scopeRevision: number }
export interface IndexState {
  version: IndexVersion; state: 'empty' | 'building' | 'ready' | 'stale' | 'failed' | 'cancelled';
  reasonCodes: string[];
}
export interface FileCoverage {
  fileId: string; status: 'parsed' | 'nodeOnly' | 'skipped' | 'failed';
  reasonCodes: string[]; unresolvedCount: number;
}
export type SymbolNamespace = 'type' | 'value' | 'both';
export interface ExportEntry {
  fileId: string; name: string; namespace: SymbolNamespace; range?: SourceRange;
  kind: 'direct' | 'forward' | 'star' | 'namespace';
  forwarded?: { relationId?: string; imported: string };
}
export interface BindingOccurrence {
  relationId: string; imported: string; local?: string; typeOnly: boolean; range?: SourceRange; exported?: string;
}
export interface ExportResolution {
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'unsupported'; reasonCodes: string[];
  candidates: { fileId: string; name: string; namespace: SymbolNamespace; range?: SourceRange; relationIds: string[] }[];
}
export type QuerySpec =
  | { kind: 'impact'; seeds: string[]; depth: number; includeInferred: boolean; includeTypes: boolean }
  | { kind: 'neighbourhood'; anchorId: string; direction: 'incoming' | 'outgoing'; depth: number }
  | { kind: 'path'; fromId: string; toId: string }
  | { kind: 'symbol'; fileId: string; exported: string; namespace: SymbolNamespace };
export interface EffectiveQueryLimits { maxNodes: number; maxRelations: number; deadlineMs: number }
export const queryLimits: EffectiveQueryLimits = { maxNodes: 10000, maxRelations: 50000, deadlineMs: 1500 };
export interface QueryRequest {
  type: 'query'; apiVersion: 1; requestId: string; graph: IndexVersion; query: QuerySpec;
  limits: EffectiveQueryLimits; gitRevision?: number;
}
export interface EvidencePath { nodeId: string; nodeIds: string[]; relationIds: string[]; depth: number }
interface QueryResultBase {
  type: 'queryResult'; requestId: string; graph: IndexVersion;
  operation: 'success' | 'cancelled' | 'failed'; coverage: 'complete' | 'partial' | 'unknown';
  freshness: 'current' | 'stale'; reasonCodes: string[]; limits: EffectiveQueryLimits;
  visitedNodes: number; examinedRelations: number; nodeIds: string[]; relationIds: string[];
  witnesses: EvidencePath[]; gitRevision?: number;
}
export type QueryResult = QueryResultBase & (
  | { kind: 'impact'; outcome: 'found' | 'notFoundWithinScope' | 'notFoundWithinLimits' | 'unknown'; directIds: string[]; indirectIds: string[]; testIds: string[] }
  | { kind: 'neighbourhood'; outcome: 'found' | 'notFoundWithinScope' | 'notFoundWithinLimits' | 'unknown' }
  | { kind: 'path'; outcome: 'found' | 'notFoundWithinScope' | 'notFoundWithinLimits' | 'unknown' }
  | { kind: 'symbol'; outcome: 'resolved' | 'ambiguous' | 'unresolved' | 'unsupported'; resolution: ExportResolution }
);
export interface BranchIntent { id: string; anchorId: string; direction: 'incoming' | 'outgoing'; depth: number; result?: QueryResult }
export interface ActiveQuery { requestId: string; query: QuerySpec; state: 'running' | 'ready' | 'cancelled' | 'failed' | 'stale'; result?: QueryResult; previousResult?: QueryResult; gitRevision?: number }
export interface BuildIdentity { extensionVersion: string; buildId: string; protocolVersion: number; capabilities: string[] }
export interface RuntimeState {
  host: BuildIdentity; worker?: BuildIdentity; webview?: BuildIdentity; installedVersion: string;
  compatible: boolean; reasonCodes: string[];
}
export interface GitChangeRow {
  id: string; repoId: string; relativePath: string; originalRelativePath?: string; originalFile?: FileRef; file?: FileRef;
  staged: boolean; unstaged: boolean; untracked: boolean; conflict: boolean; dirty: boolean;
  indexedNodeId?: string; scopeStatus: 'indexed' | 'deleted' | 'unindexed' | 'excluded' | 'bufferOnly';
}
export interface GitStatusSnapshot {
  gitRevision: number; providerState: 'available' | 'inactive' | 'disabled' | 'unavailable' | 'failed';
  observedAt: number; repositories: { id: string; label: string; state: 'available' | 'failed' }[];
  rows: GitChangeRow[]; omissions: number; reasonCodes: string[];
}
export interface TaskContextData {
  view: ViewState; ui: SavedUiState; query?: QuerySpec; branches: Omit<BranchIntent, 'result'>[];
  selection: { nodeIds: string[]; relationIds: string[] };
}
export interface SavedTaskContext {
  version: 1; storeId: string; groupId: string; savedAt: number; groupFingerprint: string; data: TaskContextData;
}
export interface TaskContextPreview {
  groupId: string; savedAt: number; missingNodeIds: string[]; groupChanged: boolean; groupMissing: boolean;
  reasonCodes: string[]; data: TaskContextData;
}
export interface TaskContextState {
  savedGroupIds: string[]; orphanedGroupIds: string[]; preview?: TaskContextPreview; message?: string;
  restore?: { token: string; data: TaskContextData };
}
export interface AnalyticsState {
  index: IndexState; runtime: RuntimeState; active?: ActiveQuery; branches: BranchIntent[];
  git?: GitStatusSnapshot; taskContexts: TaskContextState;
  uiStateToken?: string;
}
export const sameIndex = (a: IndexVersion, b: IndexVersion): boolean => a.epoch === b.epoch && a.revision === b.revision && a.scopeRevision === b.scopeRevision;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 20000;
const ids = (v: unknown, cap = 200): v is string[] => Array.isArray(v) && v.length <= cap && v.every(id);
const depth = (v: unknown) => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 20;
export function isQuerySpec(v: unknown): v is QuerySpec {
  if (!record(v)) return false;
  switch (v.kind) {
    case 'impact': return keys(v, ['kind', 'seeds', 'depth', 'includeInferred', 'includeTypes']) && ids(v.seeds) && v.seeds.length > 0 && depth(v.depth) && typeof v.includeInferred === 'boolean' && typeof v.includeTypes === 'boolean';
    case 'neighbourhood': return keys(v, ['kind', 'anchorId', 'direction', 'depth']) && id(v.anchorId) && ['incoming', 'outgoing'].includes(String(v.direction)) && depth(v.depth);
    case 'path': return keys(v, ['kind', 'fromId', 'toId']) && id(v.fromId) && id(v.toId);
    case 'symbol': return keys(v, ['kind', 'fileId', 'exported', 'namespace']) && id(v.fileId) && id(v.exported) && v.exported.length <= 1000 && ['type', 'value', 'both'].includes(String(v.namespace));
    default: return false;
  }
}
export function querySeeds(q: QuerySpec): string[] {
  return q.kind === 'impact' ? q.seeds : q.kind === 'neighbourhood' ? [q.anchorId] : q.kind === 'path' ? [q.fromId, q.toId] : [q.fileId];
}
export function isQueryRequest(v: unknown): v is QueryRequest {
  if (!record(v) || !record(v.graph) || !record(v.limits)) return false;
  const graph = v.graph, limits = v.limits;
  return keys(v, ['type', 'apiVersion', 'requestId', 'graph', 'query', 'limits', 'gitRevision']) && v.type === 'query' && v.apiVersion === 1 && id(v.requestId) && v.requestId.length <= 200
    && keys(graph, ['epoch', 'revision', 'scopeRevision']) && id(graph.epoch)
    && ['revision', 'scopeRevision'].every(k => Number.isSafeInteger(graph[k]) && Number(graph[k]) >= 0)
    && isQuerySpec(v.query) && keys(limits, ['maxNodes', 'maxRelations', 'deadlineMs'])
    && Object.entries(queryLimits).every(([k, cap]) => Number.isInteger(limits[k]) && Number(limits[k]) > 0 && Number(limits[k]) <= cap)
    && (v.gitRevision === undefined || Number.isSafeInteger(v.gitRevision) && Number(v.gitRevision) >= 0);
}
export function graphHasQuerySeeds(graph: GraphSnapshot, query: QuerySpec): boolean {
  return querySeeds(query).every(id => graph.nodes.some(n => n.id === id && n.file));
}
