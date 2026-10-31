import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createGraphAppearance, FORMAT_COLORS, formatFill, folderTint, groupFilterIds } from '../../src/webview/appearance';
import type { AnnotationGroup } from '../../src/host/annotations';
import { emptyGraph, fileId, relationId, type GraphNode } from '../../src/shared/model';

const source: GraphNode = { id: fileId({ rootId: 'app', path: 'src/main.tsx' }), file: { rootId: 'app', path: 'src/main.tsx' }, kind: 'file', label: 'main.tsx', format: '.tsx', projectId: 'app' };
const target: GraphNode = { id: fileId({ rootId: 'app', path: 'src/data.json' }), file: { rootId: 'app', path: 'src/data.json' }, kind: 'file', label: 'data.json', format: '.json', projectId: 'app' };
const edge = { id: relationId(source.id, target.id, 'import', './data.json'), sourceId: source.id, targetId: target.id, kind: 'import' as const, certainty: 'confirmed' as const, specifier: './data.json', bindings: [], evidence: [] };
const graph = { ...emptyGraph(), nodes: [source, target], relations: [edge] };
const group: AnnotationGroup = { id: 'task', name: 'Task', color: '#ef4444', files: [], relations: [{ source: source.file!, target: target.file!, kind: 'import', specifier: './data.json', note: 'Keep' }] };

test('common source, data, styles and resource formats have distinct stable fills', () => {
  const formats = ['.js', '.jsx', '.ts', '.tsx', '.json', '.env', '.css', '.scss', '.sass', '.less', '.styl', '.svg', '.png', '.jpg', '.webp', '.woff2', '.mp3', '.mp4', '.wasm'];
  const colors = formats.map(format => formatFill({ kind: 'file', format }));
  assert.equal(new Set(colors).size, formats.length);
  assert.ok(colors.every(color => /^#[a-f0-9]{6}$/.test(color)));
  assert.equal(formatFill({ kind: 'file', format: '.TSX' }), FORMAT_COLORS['.tsx']);
  assert.equal(formatFill({ kind: 'file', format: '.env.local' }), FORMAT_COLORS['.env']);
  assert.equal(folderTint('group:folder:app/src'), folderTint('group:folder:app/src'));
});

test('relation marks color only strokes, while group filtering includes endpoints', () => {
  const appearance = createGraphAppearance(graph, group, [{ id: 'folder:app/src' }]);
  assert.equal(appearance.edgeColors.get(edge.id), '#ef4444');
  assert.equal(appearance.nodeBorders.size, 0);
  assert.equal(appearance.nodeFills.get(source.id), FORMAT_COLORS['.tsx']);
  assert.equal(appearance.nodeFills.get(target.id), FORMAT_COLORS['.json']);
  assert.deepEqual(groupFilterIds(graph, group), new Set([edge.id, source.id, target.id]));
  assert.equal(appearance.folderColors.get('folder:app/src'), folderTint('folder:app/src'));
});

test('explicit file marks use borders and disabling task colors preserves base colors and mark membership', () => {
  const marked: AnnotationGroup = { ...group, files: [{ file: source.file!, note: 'Task note' }] };
  const before = JSON.stringify(marked);
  const appearance = createGraphAppearance(graph, marked);
  assert.equal(appearance.nodeBorders.get(source.id), '#ef4444');
  assert.ok(!appearance.nodeBorders.has(target.id));
  const hidden = createGraphAppearance(graph, marked, [], false);
  assert.equal(hidden.nodeBorders.size, 0); assert.equal(hidden.edgeColors.size, 0);
  assert.deepEqual(hidden.nodeFills, appearance.nodeFills);
  assert.equal(JSON.stringify(marked), before);
});

test('relation matching keeps logical identity and rejects different root, target and specifier', () => {
  for (const changed of [
    { ...group.relations[0], source: { ...source.file!, rootId: 'other' } },
    { ...group.relations[0], target: { ...target.file!, rootId: 'other' } },
    { ...group.relations[0], specifier: './other.json' }
  ]) {
    assert.equal(createGraphAppearance(graph, { ...group, relations: [changed] }).edgeColors.size, 0);
  }
  assert.equal(createGraphAppearance(graph, { ...group, color: 'url(javascript:bad)' }).edgeColors.size, 0);
});
