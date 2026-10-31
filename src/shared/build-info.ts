import type { BuildIdentity } from './query-model';
declare const __DEPENDENCY_MAP_BUILD__: BuildIdentity;
export const buildInfo: BuildIdentity = typeof __DEPENDENCY_MAP_BUILD__ !== 'undefined'
  ? __DEPENDENCY_MAP_BUILD__
  : { extensionVersion: '0.2.0', buildId: 'development', protocolVersion: 2, capabilities: ['queries', 'branches', 'git', 'taskContexts', 'diagnostics'] };
export function compatibleBuild(other?: BuildIdentity): boolean {
  return !!other && other.protocolVersion === buildInfo.protocolVersion && other.buildId === buildInfo.buildId;
}
