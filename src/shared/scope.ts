import type { GraphNode, GraphSnapshot } from './model';
import { ROLE_LABELS } from './roles';

export interface ScopeSpec {
  version: 1;
  folders: { rootId: string; path: string }[];
  excludeRoles: string[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key));
export function isScopeSpec(value: unknown): value is ScopeSpec {
  if (!record(value) || !fields(value, ['version', 'folders', 'excludeRoles']) || value.version !== 1
    || !Array.isArray(value.folders) || !value.folders.length || value.folders.length > 50
    || !Array.isArray(value.excludeRoles) || value.excludeRoles.length > 30 || !value.excludeRoles.every(role => typeof role === 'string' && Object.hasOwn(ROLE_LABELS, role))) return false;
  return value.folders.every(folder => record(folder) && fields(folder, ['rootId', 'path'])
    && typeof folder.rootId === 'string' && folder.rootId.length > 0 && folder.rootId.length <= 200 && !/[\s/\\:\u0000-\u001f]/.test(folder.rootId)
    && typeof folder.path === 'string' && folder.path.length > 0 && folder.path.length <= 4096
    && (folder.path === '.' || !/[\\:\u0000-\u001f]/.test(folder.path) && !folder.path.startsWith('/')
      && !folder.path.split('/').some(part => !part || part === '.' || part === '..' || ['.git', 'node_modules'].includes(part.toLowerCase()))));
}
export function normalizeScope(scope: ScopeSpec): ScopeSpec {
  if (!isScopeSpec(scope)) throw new Error('Invalid scope.');
  const folders = [...new Map(scope.folders.map(folder => [JSON.stringify([folder.rootId, folder.path]), { ...folder }])).values()]
    .filter(folder => !scope.folders.some(parent => parent.rootId === folder.rootId && parent.path !== folder.path
      && (parent.path === '.' || folder.path.startsWith(parent.path + '/'))))
    .sort((a, b) => a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { version: 1, folders, excludeRoles: [...new Set(scope.excludeRoles)].sort() };
}
export function scopeSignature(scope?: ScopeSpec): string { return scope ? JSON.stringify(normalizeScope(scope)) : 'all'; }
export function inScope(node: GraphNode | undefined, scope?: ScopeSpec): boolean {
  if (!scope) return !!node;
  return !!node?.file && (!node.role || !scope.excludeRoles.includes(node.role)) && scope.folders.some(folder => folder.rootId === node.file!.rootId
    && (folder.path === '.' || node.file!.path === folder.path || node.file!.path.startsWith(folder.path + '/')));
}
/** A scoped index owns its export tables; full-index export caches can never cross this boundary. */
export function scopedGraph(graph: GraphSnapshot, scope?: ScopeSpec): GraphSnapshot {
  if (!scope) return graph;
  const nodes = graph.nodes.filter(node => inScope(node, scope)), ids = new Set(nodes.map(node => node.id));
  const relations = graph.relations.filter(edge => ids.has(edge.sourceId) && ids.has(edge.targetId) && (edge.provenanceIds ?? []).every(id => ids.has(id)));
  const proofBoundary = graph.relations.some(edge => ids.has(edge.sourceId) && ids.has(edge.targetId) && edge.provenanceIds?.some(id => !ids.has(id)));
  const edgeIds = new Set(relations.map(edge => edge.id));
  return { ...graph, nodes, relations,
    coverageReasons: [...(graph.coverageReasons ?? []), ...(proofBoundary ? ['frameworkScopeBoundary'] : [])],
    unresolved: graph.unresolved.filter(row => ids.has(row.sourceId)),
    diagnostics: graph.diagnostics.filter(row => !row.fileId || ids.has(row.fileId)),
    coverage: graph.coverage?.filter(row => ids.has(row.fileId)), exports: graph.exports?.filter(row => ids.has(row.fileId)),
    bindingOccurrences: graph.bindingOccurrences?.filter(row => edgeIds.has(row.relationId)),
    physicalFileIds: graph.physicalFileIds?.filter(id => ids.has(id)), declarations: [],
  };
}
