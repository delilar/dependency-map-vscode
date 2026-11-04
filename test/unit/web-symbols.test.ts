import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJavascript } from '../../src/analysis/javascript';
import { fileMetadata } from '../../src/shared/file-metadata';
import { createGraphAppearance, FAMILY_COLORS } from '../../src/webview/appearance';
import { emptyGraph, fileId } from '../../src/shared/model';

test('literal named CommonJS assignments expose declarations but mutation or aliases stay unsupported', () => {
  const simple = extractJavascript('source.cjs', 'const run=()=>1; exports.run = run; module.exports.value = 2;');
  assert.equal(simple.unsupportedExports, false);
  assert.deepEqual(simple.exports.map(entry => entry.name).sort(), ['run', 'value']);
  assert(extractJavascript('source.cjs', 'exports.run=1; Object.assign(exports, source);').unsupportedExports);
  assert(extractJavascript('source.cjs', 'module.exports={run:1};').unsupportedExports);
  assert(!extractJavascript('source.js', 'function f(exports){exports.run=1;}').exports.some(entry => entry.name === 'run'));
});

test('JSX uses real imported bindings and namespace members, excluding intrinsic and shadowed tags', () => {
  const parsed = extractJavascript('view.tsx', 'import {Card as C} from "./card"; import * as UI from "./ui"; const view=<><C/><UI.Button/><card/></>; function Other(C){return <C/>;}');
  const uses = parsed.references.filter(reference => reference.evidence.rule.startsWith('JSX component'));
  assert.deepEqual(uses.map(reference => reference.bindings[0].imported), ['Card', 'Button']);
  assert(uses.every(reference => reference.occurrences?.length === 1));
});

test('family presentation preserves language and folder task count independently of visible subset', () => {
  const node = (name: string) => ({ id: fileId({ rootId: 'r', path: 'src/' + name }), file: { rootId: 'r', path: 'src/' + name }, label: name, kind: 'file' as const, format: '.vue', projectId: 'p', ...fileMetadata('.vue', 'component') });
  const nodes = [node('A.vue'), node('B.vue')];
  const appearance = createGraphAppearance({ ...emptyGraph(), nodes }, { id: 'task', name: 'Task', color: '#ef4444', files: [{ file: nodes[0].file }], relations: [] }, [{ id: 'group:folder:r/src' }], true, 'family');
  assert.equal(appearance.nodeFills.get(nodes[0].id), FAMILY_COLORS.ui);
  assert.equal(nodes[0].languageId, 'VUE');
  assert.deepEqual(appearance.folderMarks.get('group:folder:r/src'), { marked: 1, total: 2 });
  assert.equal(appearance.nodeBorders.get(nodes[0].id), '#ef4444');
});
