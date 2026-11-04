import type { GraphNode } from '../shared/model';
import { isScopeSpec, type ScopeSpec } from '../shared/scope';
import { ROLE_LABELS } from '../shared/roles';

export function describeScope(scope: ScopeSpec | undefined, nodes: GraphNode[]): string {
  if (!scope) return 'весь индекс';
  const rootName = (id: string) => nodes.find(node => node.file?.rootId === id)?.projectName ?? 'недоступный корень';
  return scope.folders.map(folder => `${rootName(folder.rootId)}/${folder.path}`).join(', ')
    + (scope.excludeRoles.length ? `; без ${scope.excludeRoles.map(role => ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role).join(', ')}` : '');
}
export function describeScopeSignature(signature: string | undefined, nodes: GraphNode[]): string {
  if (!signature || signature === 'all') return 'весь индекс';
  try { const scope: unknown = JSON.parse(signature); return isScopeSpec(scope) ? describeScope(scope, nodes) : 'ограниченная область'; }
  catch { return 'ограниченная область'; }
}
