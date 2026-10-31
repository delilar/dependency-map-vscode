export { extractEnvironmentKeys } from '../shared/environment';

export function isEnvironmentFile(filePath: string): boolean {
  const name = (filePath.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
  return name === '.env' || name.startsWith('.env.');
}

