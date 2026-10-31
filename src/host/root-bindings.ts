import { randomUUID } from 'node:crypto';
import type { WorkspaceRoot } from '../shared/model';

export function applyRootBindings(roots: WorkspaceRoot[], savedIds: string[], assignments: Record<string, string>): WorkspaceRoot[] {
  const paths = Object.values(assignments);
  if (new Set(paths).size !== paths.length || paths.some(value => !roots.some(root => root.path === value)) || Object.keys(assignments).some(id => !savedIds.includes(id))) {
    throw new Error('Root bindings must be unique open folders.');
  }
  return roots.map(root => ({ ...root, id: Object.keys(assignments).find(id => assignments[id] === root.path) ?? (savedIds.includes(root.id) ? randomUUID() : root.id) }));
}
