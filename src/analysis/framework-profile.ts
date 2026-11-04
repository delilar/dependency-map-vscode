export interface FrameworkProfile {
  status: 'absent' | 'supported' | 'unknown' | 'unsupported';
  major?: number;
}

export function frameworkProfile(manifest: any, name: string, supportedMajors: readonly number[]): FrameworkProfile {
  const versions = [manifest?.dependencies?.[name], manifest?.devDependencies?.[name], manifest?.peerDependencies?.[name], manifest?.optionalDependencies?.[name]].filter(value => value !== undefined);
  if (!versions.length) return { status: 'absent' };
  if (versions.some(value => typeof value !== 'string') || new Set(versions.map(value => value.trim())).size !== 1) return { status: 'unknown' };
  // shortcut: complex ranges need an explicit profile; extend this only with proven major compatibility rules.
  const match = /^[~^=]?(0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.exec(versions[0].trim());
  const major = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(major)) return { status: 'unknown' };
  return { status: supportedMajors.includes(major) ? 'supported' : 'unsupported', major };
}
