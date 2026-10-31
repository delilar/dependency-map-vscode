import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyGraph, initialView, relationId, type GraphNode, type Relation } from '../../src/shared/model';
import { displayLabels, groupProjection, projectGraph, searchGraph } from '../../src/webview/graph';

const node = (id: string, kind: 'file' | 'external' = 'file'): GraphNode => ({ id, label: id, kind, projectId: 'app', format: '.ts', file: kind === 'file' ? { rootId: 'app', path: `${id}.ts` } : undefined });
const edge = (sourceId: string, targetId: string, kind: Relation['kind'] = 'import'): Relation => ({ id: relationId(sourceId, targetId, kind), sourceId, targetId, kind, certainty: 'confirmed', bindings: [], evidence: [{ rule: 'fixture' }] });

test('file view follows both directions, respects depth and keeps search global', () => {
  const graph = { ...emptyGraph(), nodes: ['page', 'hook', 'store', 'router', 'hidden'].map(id => node(id)), relations: [edge('page', 'hook'), edge('hook', 'store'), edge('router', 'page')] };
  const projection = projectGraph(graph, { ...initialView(), focusId: 'page' });
  assert.deepEqual(new Set(projection.nodes.map(item => item.id)), new Set(['page', 'hook', 'router']));
  assert.equal(projectGraph(graph, { ...initialView(), focusId: 'page', depth: 2 }).nodes.length, 4);
  assert.deepEqual(searchGraph(graph, 'hidden').map(item => item.id), ['hidden']);
});
test('search finds imported aliases and reveal bypasses visual filters', () => {
  const relation = edge('page', 'react'); relation.bindings = [{ imported: 'useMemo', local: 'memo', typeOnly: false }];
  const graph = { ...emptyGraph(), nodes: [node('page'), node('react', 'external')], relations: [relation] };
  assert.equal(searchGraph(graph, 'useMemo').length, 2);
  assert.equal(projectGraph(graph, { ...initialView(), mode: 'project' }).nodes.length, 1);
  assert.equal(projectGraph(graph, { ...initialView(), mode: 'project' }, { forcedIds: new Set(['react']) }).nodes.length, 2);
});
test('collapsed reexports retain actual relations and do not mutate the graph', () => {
  const graph = { ...emptyGraph(), nodes: ['page', 'index', 'button'].map(id => node(id)), relations: [edge('page', 'index'), edge('index', 'button', 'reexport')] };
  const projection = projectGraph(graph, { ...initialView(), mode: 'project', focusId: 'page', collapseReexports: true });
  assert.deepEqual(projection.nodes.map(item => item.id), ['page', 'button']);
  assert.equal(projection.edges.length, 1); assert.equal(projection.edges[0].collapsed, true);
  assert.deepEqual(projection.edges[0].relations.map(item => item.id), graph.relations.map(item => item.id));
  assert.equal(graph.nodes.length, 3); assert.equal(graph.relations.length, 2);
});
test('reexport cycles remain inspectable and protected search targets remain visible', () => {
  const graph = { ...emptyGraph(), nodes: ['page', 'a', 'b'].map(id => node(id)), relations: [edge('page', 'a'), edge('a', 'b', 'reexport'), edge('b', 'a', 'reexport')] };
  assert.equal(projectGraph(graph, { ...initialView(), mode: 'project', collapseReexports: true }).nodes.length, 3);
  const acyclic = { ...graph, relations: [edge('page', 'a'), edge('a', 'b', 'reexport')] };
  assert.equal(projectGraph(acyclic, { ...initialView(), mode: 'project', collapseReexports: true }, { forcedIds: new Set(['a']) }).nodes.length, 3);
});
test('project, format, group and direction filters do not leak unrelated files', () => {
  const graph = { ...emptyGraph(), nodes: [node('page'), node('hook'), { ...node('image'), format: '.svg' }], relations: [edge('page', 'hook'), edge('page', 'image', 'resource')] };
  assert.deepEqual(projectGraph(graph, { ...initialView(), focusId: 'page' }, { direction: 'incoming' }).nodes.map(item => item.id), ['page']);
  assert.deepEqual(projectGraph(graph, { ...initialView(), mode: 'project' }, { format: '.svg' }).nodes.map(item => item.id), ['image']);
  assert.deepEqual(projectGraph(graph, { ...initialView(), mode: 'project' }, { markedIds: new Set(['hook']) }).nodes.map(item => item.id), ['hook']);
});

test('project names are searchable while project filtering retains stable internal IDs', () => {
  const graph = { ...emptyGraph(), nodes: [{ ...node('page'), projectId: 'project:internal-id', projectName: 'Customer portal' }], relations: [] };
  assert.deepEqual(searchGraph(graph, 'customer portal').map(item => item.id), ['page']);
  assert.equal(projectGraph(graph, { ...initialView(), mode: 'project' }, { project: 'project:internal-id' }).nodes.length, 1);
  assert.equal(projectGraph(graph, { ...initialView(), mode: 'project' }, { project: 'Customer portal' }).nodes.length, 0);
});

test('collapsing an application aggregates cross-area edges with real relation identities', () => {
  const graph = { ...emptyGraph(), nodes: [{ ...node('one'), projectId: 'main' }, { ...node('two'), projectId: 'main' }, { ...node('consumer'), projectId: 'child' }],
    relations: [edge('consumer', 'one'), edge('consumer', 'two'), edge('one', 'two')] };
  const projection = projectGraph(graph, { ...initialView(), mode: 'project' });
  const grouped = groupProjection(projection, 'project', new Set(['group:project:main']));
  assert.deepEqual(grouped.nodes.map(item => item.id), ['consumer']);
  assert.equal(grouped.groups.find(item => item.id === 'group:project:main')?.collapsed, true);
  assert.equal(grouped.edges.length, 1); assert.equal(grouped.edges[0].targetId, 'group:project:main');
  assert.deepEqual(grouped.edges[0].relations.map(item => item.id), graph.relations.slice(0, 2).map(item => item.id));
  assert.equal(graph.nodes.length, 3); assert.equal(graph.relations.length, 3);
});

test('search reveal expands only the containing folder without changing saved collapsed choices', () => {
  const graph = { ...emptyGraph(), nodes: [{ ...node('one'), file: { rootId: 'app', path: 'src/ui/One.ts' } }, { ...node('two'), file: { rootId: 'app', path: 'src/data/Two.ts' } }], relations: [] };
  const collapsed = new Set(['group:folder:app/src/ui', 'group:folder:app/src/data']);
  const projection = projectGraph(graph, { ...initialView(), mode: 'project' });
  const grouped = groupProjection(projection, 'folder', collapsed, new Set(['one']));
  assert.deepEqual(grouped.nodes.map(item => item.id), ['one']);
  assert.equal(grouped.groups.find(item => item.id === 'group:folder:app/src/ui')?.collapsed, false);
  assert.equal(grouped.groups.find(item => item.id === 'group:folder:app/src/data')?.collapsed, true);
  assert.equal(collapsed.size, 2);
});

test('combined role and folder filters respect path boundaries while explicit reveal bypasses them', () => {
  const graph = { ...emptyGraph(), nodes: [
    { ...node('user'), role: 'type', file: { rootId: 'app', path: 'src/types/User.d.ts' } },
    { ...node('other'), role: 'type', file: { rootId: 'app', path: 'src/types-old/Other.d.ts' } },
    { ...node('config'), role: 'config', file: { rootId: 'app', path: 'src/types/config.json' } }
  ], relations: [] };
  const options = { role: 'type', folder: './src\\types/' };
  assert.deepEqual(projectGraph(graph, { ...initialView(), mode: 'project' }, options).nodes.map(item => item.id), ['user']);
  assert.deepEqual(projectGraph(graph, { ...initialView(), mode: 'project' }, { ...options, forcedIds: new Set(['config']) }).nodes.map(item => item.id), ['user', 'config']);
});

test('duplicate basenames receive the shortest unique path suffix without changing their IDs', () => {
  const nodes = [
    { ...node('page'), label: 'index.tsx', file: { rootId: 'app', path: 'src/pages/index.tsx' } },
    { ...node('catalog'), label: 'index.tsx', file: { rootId: 'app', path: 'src/containers/catalog/index.tsx' } },
    { ...node('profile'), label: 'index.tsx', file: { rootId: 'app', path: 'src/containers/profile/index.tsx' } },
    node('useProfile.ts')
  ];
  const labels = displayLabels(nodes);
  assert.equal(labels.get('page'), 'pages/index.tsx');
  assert.equal(labels.get('catalog'), 'catalog/index.tsx');
  assert.equal(labels.get('profile'), 'profile/index.tsx');
  assert.equal(labels.get('useProfile.ts'), 'useProfile.ts');
  assert.deepEqual(nodes.map(item => item.id), ['page', 'catalog', 'profile', 'useProfile.ts']);
});
