import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace } from '../../src/analysis/index';
import { extractJavascript } from '../../src/analysis/javascript';

test('Tramvai options escaping through containers and destructuring cannot retain stale module proofs', () => {
  for (const mutation of ['const wrapper={options}; wrapper.options.modules=[B];', 'const wrapper=[options]; wrapper[0].modules=[B];', 'const {modules}=options; modules.push(B);', 'mutate({options});']) {
    const result = extractJavascript('app.ts', `import {createApp} from "@tramvai/core"; import {A} from "./a"; import {B} from "./b"; const options={modules:[A]}; ${mutation} createApp(options);`);
    assert(!result.references.some(row => row.kind === 'framework' && /createApp.modules/.test(row.evidence.rule)), mutation);
    assert(result.diagnostics.length || result.references.some(row => row.reason), mutation);
  }
  const positive = extractJavascript('app.ts', 'import {createApp} from "@tramvai/core"; import {A} from "./a"; const modules=[A]; const options={modules}; const wrapper={options}; createApp(options);');
  assert(positive.references.some(row => row.kind === 'framework' && row.bindings[0]?.imported === 'A'), 'Creating an unmutated container is not itself a mutation');
});

test('var declarations inside a static block or namespace do not shadow outside CommonJS require', () => {
  for (const source of ['class X {static {var require=fn;require("./inside");}} require("./outside");', 'namespace X {var require=fn;require("./inside");} require("./outside");']) {
    const result = extractJavascript('scope.ts', source);
    assert.deepEqual(result.references.filter(row => row.kind === 'import').map(row => row.specifier), ['./outside']);
  }
});

test('an exhausted object alias budget reports uncertainty instead of retaining immutable proofs', () => {
  const properties = Array.from({ length: 10010 }, (_, i) => `p${i}:0`).join(',');
  const result = extractJavascript('large.ts', `import {createApp} from "@tramvai/core"; import {A} from "./a"; const options={modules:[A]}; const wrapper={options,${properties}}; mutate(wrapper); createApp(options);`);
  assert(result.diagnostics.some(message => message.includes('alias expansion limit')));
  assert(!result.references.some(row => row.kind === 'framework' && row.evidence.rule.includes('createApp.modules')));
  const aliases = Array.from({ length: 25 }, (_, i) => `const alias${i}=${i ? `alias${i - 1}` : 'options'};`).join('');
  const deep = extractJavascript('deep.ts', `import {createApp} from "@tramvai/core"; import {A} from "./a"; const options={modules:[A]}; ${aliases} alias24.modules.push(A); createApp(options);`);
  assert(deep.diagnostics.some(message => message.includes('alias expansion limit')));
  assert(!deep.references.some(row => row.kind === 'framework' && row.evidence.rule.includes('createApp.modules')));
});

test('a nested Vite config does not establish the CLI working directory for root URLs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-review-'));
  try {
    for (const [name, text] of Object.entries({
      'package.json': '{"dependencies":{"vite":"6.0.0"},"scripts":{"dev":"vite --config nested/vite.config.ts"}}',
      'nested/vite.config.ts': 'export default {};', 'nested/index.html': '<script type="module" src="/src/main.ts"></script>',
      'src/main.ts': 'export const correct=1;', 'nested/src/main.ts': 'export const nested=1;',
    })) { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
    const graph = await analyzeWorkspace([{ id: 'root', name: 'root', path: directory }], { exclude: [] }, []);
    const source = graph.nodes.find(row => row.file?.path === 'nested/index.html')!;
    assert(!graph.relations.some(row => row.sourceId === source.id && row.certainty === 'confirmed'));
    assert(graph.unresolved.some(row => row.sourceId === source.id));
    assert(graph.coverage?.find(row => row.fileId === source.id)?.reasonCodes.length);
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-review-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
