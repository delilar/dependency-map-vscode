import { build } from 'esbuild';
import { runTests, runVSCodeCommand } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildResult = spawnSync(process.execPath, [path.join(project, 'scripts/build.mjs')], { cwd: project, stdio: 'inherit' });
if (buildResult.status !== 0) throw new Error('Build failed before integration tests');
const testEntry = path.join(project, '.test-dist', 'integration.cjs');
await build({ entryPoints: [path.join(project, 'test/integration/index.ts')], outfile: testEntry, bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'] });

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dependency-map-integration-'));
const web = path.join(temporary, 'web');
const child = path.join(temporary, 'child');
const workspace = path.join(temporary, 'integration.code-workspace');
async function file(root, relative, content) {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}
try {
  await file(web, 'package.json', JSON.stringify({ name: 'integration-web', private: true, dependencies: { '@angular/core': '21.0.0' }, dependencyMap: { graphqlDocuments: ['src/*.graphql'] } }));
  await file(web, 'tsconfig.json', JSON.stringify({ compilerOptions: { moduleResolution: 'node', baseUrl: '.', paths: { '@/*': ['src/*'] }, resolveJsonModule: true } }));
  await file(web, 'src/main.ts', 'import { value } from "@/value";\nimport "./styles.css";\nimport "./styles.less";\nimport "./styles.styl";\nimport "./styles.sass";\nimport data from "./data.json";\nexport const result = value + data.n;\nexport const api = process.env.API_URL;\n');
  await file(web, 'src/value.ts', 'export const value = 1;\n');
  await file(web, 'src/changed.ts', 'export const changed = 2;\n');
  await file(web, 'src/Card.vue', '<script setup lang="ts">import {value} from "./value";</script><template><div/></template>');
  await file(web, 'src/Widget.svelte', '<script>import {value} from "./value";</script><div/>');
  await file(web, 'src/Home.astro', '---\nimport Card from "./Card.vue";\n---\n<Card/>');
  await file(web, 'src/guide.mdx', 'import Card from "./Card.vue";\n\n# Guide\n\n<Card/>');
  await file(web, 'src/components.ts', 'export {default as Card} from "./Card.vue";');
  await file(web, 'src/web-stack.ts', 'import {Card} from "./components"; import Widget from "./Widget.svelte"; import Home from "./Home.astro"; import Guide from "./guide.mdx";');
  await file(web, 'src/NgCard.ts', 'import {Component} from "@angular/core"; @Component({selector:"app-card",template:"<div/>"}) export class NgCard {}');
  await file(web, 'src/NgPage.ts', 'import {Component} from "@angular/core"; import {NgCard} from "./NgCard"; @Component({imports:[NgCard],templateUrl:"./NgPage.html"}) export class NgPage {}');
  await file(web, 'src/NgPage.html', '<app-card/>');
  await file(web, 'src/query.graphql', 'query Q {user {...User}}');
  await file(web, 'src/fragment.graphql', 'fragment User on User {id}');
  await file(web, 'src/styles.css', '.example { color: red; }\n');
  await file(web, 'src/styles.less', '@import "./palette.less"; .example { color: @accent; }\n');
  await file(web, 'src/palette.less', '@accent: #eab308;\n');
  await file(web, 'src/styles.styl', '@import "./palette.styl"\n.example\n  color accent\n');
  await file(web, 'src/palette.styl', 'accent = #eab308\n');
  await file(web, 'src/styles.sass', '@use "palette"\n.example\n  color: palette.$accent\n');
  await file(web, 'src/_palette.sass', '$accent: #eab308\n');
  await file(web, 'src/data.json', '{"n":3}\n');
  await file(web, '.env', 'API_URL=INTEGRATION_SECRET_SENTINEL\n');
  await file(web, 'node_modules/trap.ts', 'export const ignored = "NODE_MODULES_SOURCE_SENTINEL";\n');
  await file(web, '.vscode/dependency-map.json', JSON.stringify({ version: 1, roots: [{ id: 'test-web', label: 'web' }, { id: 'test-child', label: 'child' }], groups: [] }, null, 2));
  await file(child, 'package.json', JSON.stringify({ name: 'integration-child', private: true }));
  await file(child, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
  await file(child, 'src/child.ts', 'import { value } from "@/value"; export { value };\n');
  await file(child, 'src/value.ts', 'export const value = 10;\n');
  // Test setup only: product code never invokes Git or activates its provider.
  for (const root of [web, child]) {
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    for (const args of [['init', '--quiet', root], ['-C', root, 'config', 'core.fsmonitor', 'false'], ['-C', root, 'add', 'src/value.ts']]) {
      const initialized = spawnSync('git', args, { env: gitEnv, encoding: 'utf8', windowsHide: true });
      assert.equal(initialized.status, 0, 'isolated Git fixture must initialize');
    }
  }
  await file(web, 'src/value.ts', 'export const value = 1;\n// Unstaged test fixture change.\n');
  await writeFile(workspace, JSON.stringify({ folders: [{ name: 'web', path: web }, { name: 'child', path: child }], settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none' } }));
  let extensionPath = project;
  if (process.argv.includes('--installed') || process.env.DEPENDENCY_MAP_TEST_PACKAGE === '1') {
    const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    const packagePath = process.env.DEPENDENCY_MAP_TEST_PACKAGE_PATH ?? path.join(project, `${manifest.name}-${manifest.version}.vsix`);
    const installed = await runVSCodeCommand(['--install-extension', packagePath, '--force', '--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', path.join(temporary, 'extensions')], { version: process.env.VSCODE_VERSION ?? 'stable', reuseMachineInstall: false });
    console.log(installed.stdout.trim());
    const folder = (await readdir(path.join(temporary, 'extensions'))).find(name => name.startsWith(`${manifest.publisher}.${manifest.name}-`));
    assert.ok(folder, 'packaged extension must install into the isolated extensions folder');
    extensionPath = path.join(temporary, 'extensions', folder);
  }
  const options = {
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: testEntry,
    ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : { version: process.env.VSCODE_VERSION ?? 'stable' }),
    extensionTestsEnv: { DEPENDENCY_MAP_TEST: '1', DEPENDENCY_MAP_TEST_WORKSPACE: temporary, ...(process.env.DEPENDENCY_MAP_TEST_ACTIVATION === '1' ? { DEPENDENCY_MAP_TEST_ACTIVATION: '1' } : {}) },
    reuseMachineInstall: false,
    launchArgs: [workspace, '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--skip-add-to-recently-opened', '--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', path.join(temporary, 'extensions')]
  };
  if (process.env.DEPENDENCY_MAP_TEST_ACTIVATION === '1') {
    for (let sample = 0; sample < 10; sample++) {
      const args = [...options.launchArgs];
      args[args.indexOf('--user-data-dir') + 1] = path.join(temporary, `activation-profile-${sample}`);
      await runTests({ ...options, launchArgs: args });
    }
  } else {
    await runTests(options);
    await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, DEPENDENCY_MAP_TEST_RESTORE: '1' } });
  }
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temporary).startsWith('dependency-map-integration-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
