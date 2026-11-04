import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

assert(process.env.npm_execpath, 'Run this check through npm run check:release');
const steps = [
  ['package'], ['test:ui'], ['probe:parsers'],
  ['test:installed', '1.85.2'], ['test:rollback', '1.85.2'],
  ['test:installed', '1.143.1'], ['verify:package'],
];
for (const [script, version] of steps) {
  console.log(`Release check: ${script}${version ? ` (VS Code ${version})` : ''}`);
  const env = { ...process.env, ...(version ? { VSCODE_VERSION: version } : {}) };
  for (const key of ['DEPENDENCY_MAP_TEST_ACTIVATION', 'DEPENDENCY_MAP_TEST_PACKAGE_PATH', 'VSCODE_EXECUTABLE_PATH', 'PARSER_PROBE_EXECUTABLE', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', script], { env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Release checks passed: package, UI, parsers, installed minimum/current hosts and persistence.');
