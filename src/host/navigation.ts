import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FileRef, WorkspaceRoot } from '../shared/model';

export function sameFilePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

export async function resolveAllowedFile(ref: FileRef, roots: WorkspaceRoot[]): Promise<string> {
  const root = roots.find(item => item.id === ref.rootId);
  if (!root || !ref.path || path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.split('/').some(part => part === '..' || part === 'node_modules' || !part)) {
    throw new Error('File is outside the indexed workspace.');
  }
  const rootPath = await realpath(root.path);
  const filePath = await realpath(path.resolve(root.path, ref.path));
  const relative = path.relative(rootPath, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || relative.split(path.sep).includes('node_modules')) {
    throw new Error('File is outside the indexed workspace.');
  }
  return filePath;
}
