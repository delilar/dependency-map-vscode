import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { HostState, SavedUiState, UiMessage } from '../../src/shared/protocol';
import type { WorkspaceRoot } from '../../src/shared/model';
import type { AnnotationsDocument } from '../../src/host/annotations';

interface Inspection extends HostState { roots: WorkspaceRoot[]; annotations: AnnotationsDocument | undefined; localState?: SavedUiState; panelReady: boolean }
const inspect = async () => {
  const state = await vscode.commands.executeCommand<Inspection>('dependencyMap.inspect');
  assert.ok(state, 'test inspection command must return state');
  return state;
};
const dispatch = (message: UiMessage) => vscode.commands.executeCommand('dependencyMap.testMessage', message);
async function waitFor(predicate: (state: Inspection) => boolean, label: string): Promise<Inspection> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await inspect();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const state = await inspect();
  throw new Error(`Timed out: ${label}; status=${state.status}`);
}

export async function run(): Promise<void> {
  const fixture = process.env.DEPENDENCY_MAP_TEST_WORKSPACE;
  assert.ok(fixture, 'runner must provide its isolated temporary workspace');
  const mainUri = vscode.Uri.file(path.join(fixture, 'web', 'src', 'main.ts'));
  const valueUri = vscode.Uri.file(path.join(fixture, 'web', 'src', 'value.ts'));
  const marksPath = path.join(fixture, 'web', '.vscode', 'dependency-map.json');
  const extension = vscode.extensions.getExtension('local-tools.dependency-map-vscode');
  assert.ok(extension, 'development extension must be installed');
  await extension.activate();
  if (process.env.DEPENDENCY_MAP_TEST_RESTORE === '1') {
    const before = await fs.readFile(marksPath, 'utf8');
    await vscode.commands.executeCommand('dependencyMap.openProject');
    const restored = await waitFor(value => value.graph.revision > 0 && value.panelReady, 'index and live Webview handshake after restart');
    const restoredGroup = restored.annotations?.groups.find(group => group.name === 'Integration task');
    assert.ok(restoredGroup?.files.some(mark => mark.note === 'Check API'), 'file note survives extension restart');
    assert.ok(restoredGroup?.relations.some(mark => mark.note === 'Check API'), 'missing relation note survives restart');
    assert.equal(await fs.readFile(marksPath, 'utf8'), before, 'restart does not rewrite shared JSON');
    assert.ok(restored.roots.some(root => root.id === 'test-web'));
    console.log('Dependency Map restart persistence passed.');
    return;
  }
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['dependencyMap.openFile', 'dependencyMap.openProject', 'dependencyMap.rebuild', 'dependencyMap.inspect', 'dependencyMap.testMessage']) assert.ok(commands.includes(command), `${command} registered`);
  const originalMarks = await fs.readFile(marksPath, 'utf8');
  const mainDocument = await vscode.workspace.openTextDocument(mainUri);
  await vscode.window.showTextDocument(mainDocument, { preview: false });
  await vscode.commands.executeCommand('dependencyMap.openFile', mainUri);
  let state = await waitFor(value => value.graph.revision > 0 && value.panelReady, 'initial index and live Webview handshake');
  assert.equal(state.roots.length, 2);
  assert.equal(state.view.follow, false);
  assert.equal(await fs.readFile(marksPath, 'utf8'), originalMarks, 'opening map does not rewrite annotations');
  assert.ok(!JSON.stringify(state.graph).includes('INTEGRATION_SECRET_SENTINEL'));
  const main = state.graph.nodes.find(node => node.file?.rootId === 'test-web' && node.file.path === 'src/main.ts');
  const value = state.graph.nodes.find(node => node.file?.rootId === 'test-web' && node.file.path === 'src/value.ts');
  const childValue = state.graph.nodes.find(node => node.file?.rootId === 'test-child' && node.file.path === 'src/value.ts');
  assert.ok(main && value && childValue, 'same paths in two roots remain distinct');
  await dispatch({ type: 'setNodeDepth', nodeId: main.id, depth: 2 });
  await dispatch({ type: 'setView', view: { ...state.view, depth: 2 } });
  assert.equal((await inspect()).view.nodeDepths?.[main.id], 2);
  await dispatch({ type: 'setNodeDepth', nodeId: 'file:unknown:missing.ts', depth: 5 });
  assert.deepEqual((await inspect()).view.nodeDepths, { [main.id]: 2 }, 'unknown local anchor is ignored');
  await dispatch({ type: 'resetNodeDepths' });
  assert.deepEqual((await inspect()).view.nodeDepths, {});
  const initialRelation = state.graph.relations.find(edge => edge.sourceId === main.id && edge.targetId === value.id);
  assert.ok(initialRelation, 'alias resolves within correct root');
  assert.ok(!state.graph.relations.some(edge => edge.sourceId === main.id && edge.targetId === childValue.id));
  for (const extension of ['less', 'styl']) {
    const stylesheet = state.graph.nodes.find(node => node.file?.path === `src/styles.${extension}`);
    const palette = state.graph.nodes.find(node => node.file?.path === `src/palette.${extension}`);
    assert.ok(stylesheet && palette && state.graph.relations.some(edge => edge.sourceId === stylesheet.id && edge.targetId === palette.id), `${extension} parser works in the packaged worker`);
  }
  const sass = state.graph.nodes.find(node => node.file?.path === 'src/styles.sass');
  assert.ok(sass);
  const runtime = process.versions.node.split('.').map(Number);
  if (runtime[0] > 20 || runtime[0] === 20 && runtime[1] >= 19) assert.ok(state.graph.relations.some(edge => edge.sourceId === sass.id && edge.kind === 'resource'), 'Sass parser works on the supported runtime');
  else assert.ok(state.graph.diagnostics.some(item => item.fileId === sass.id), 'Old Node runtime explicitly reports Sass parser limitation');
  const declaration = state.graph.declarations?.find(item => item.relationId === initialRelation.id && item.imported === 'value');
  assert.ok(declaration, 'syntactic declaration was resolved');
  await dispatch({ type: 'openDeclaration', relationId: initialRelation.id, imported: 'value' });
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, valueUri.fsPath);
  await vscode.window.showTextDocument(mainDocument, { preview: false });

  const valueDocument = await vscode.workspace.openTextDocument(valueUri);
  await vscode.window.showTextDocument(valueDocument, { preview: false });
  assert.equal((await inspect()).view.focusId, main.id, 'pinned map retains original focus');
  await dispatch({ type: 'setView', view: { ...state.view, follow: true } });
  await waitFor(snapshot => snapshot.view.focusId === value.id, 'follow current editor');
  const dependency = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixture, 'web', 'node_modules', 'trap.ts')));
  await vscode.window.showTextDocument(dependency, { preview: false });
  assert.equal((await inspect()).view.focusId, value.id, 'follow ignores files excluded from the index');
  assert.ok(!JSON.stringify((await inspect()).graph).includes('NODE_MODULES_SOURCE_SENTINEL'));
  await vscode.window.showTextDocument(mainDocument, { preview: false });
  state = await waitFor(snapshot => snapshot.view.focusId === main.id, 'follow newly active editor');
  await dispatch({ type: 'openEvidence', relationId: initialRelation.id });
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, mainUri.fsPath);

  await dispatch({ type: 'annotation', action: 'createGroup', name: 'Integration task', color: '#eab308' });
  state = await inspect();
  assert.equal(state.annotationError, undefined);
  const group = state.annotations?.groups.find(item => item.name === 'Integration task');
  assert.ok(group);
  await dispatch({ type: 'annotation', action: 'createGroupAndMark', requestId: 'atomic-create', name: 'Atomic task', color: '#123456', relationIds: [initialRelation.id] });
  const atomic = (await inspect()).annotations?.groups.find(item => item.name === 'Atomic task');
  assert.equal(atomic?.relations.length, 1, 'create-and-mark persists selected relation atomically');
  assert.equal(atomic?.files.length, 0, 'marking relation does not mark endpoints');
  await dispatch({ type: 'annotation', action: 'createGroupAndMark', requestId: 'stale-create', name: 'Stale task', color: '#123456', nodeIds: ['file:missing:x.ts'] });
  assert.equal((await inspect()).annotations?.groups.some(item => item.name === 'Stale task'), false, 'all-stale selection cannot create an empty task silently');
  await dispatch({ type: 'annotation', action: 'mark', groupId: group.id, nodeIds: [main.id], relationIds: [initialRelation.id], note: 'Check API' });
  state = await inspect();
  const markedGroup = state.annotations?.groups.find(item => item.id === group.id);
  assert.equal(markedGroup?.files[0].note, 'Check API');
  assert.equal(markedGroup?.relations[0].note, 'Check API');
  assert.ok(!JSON.stringify(state.annotations).includes(fixture));
  if (process.platform === 'win32') {
    const content = await fs.readFile(marksPath, 'utf8');
    const shared = await vscode.workspace.openTextDocument(vscode.Uri.file(marksPath.toUpperCase()));
    await vscode.window.showTextDocument(shared, { preview: false });
    const edit = new vscode.WorkspaceEdit(); edit.insert(shared.uri, shared.positionAt(shared.getText().length), ' ');
    assert.ok(await vscode.workspace.applyEdit(edit)); assert.ok(shared.isDirty);
    await dispatch({ type: 'annotation', action: 'updateGroup', groupId: group.id, color: '#ff0000' });
    assert.ok((await inspect()).annotationError, 'dirty shared JSON blocks saving regardless of URI casing');
    assert.equal(await fs.readFile(marksPath, 'utf8'), content);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.window.showTextDocument(mainDocument, { preview: false });
  }
  await dispatch({ type: 'annotation', action: 'markFolder', groupId: group.id, nodeIds: [main.id] });
  const countBeforeCreate = (await inspect()).annotations?.groups.find(item => item.id === group.id)?.files.length;
  await fs.writeFile(path.join(fixture, 'web', 'src', 'later.ts'), 'export const later = 3;\n');
  await waitFor(snapshot => snapshot.graph.nodes.some(node => node.file?.rootId === 'test-web' && node.file.path === 'src/later.ts'), 'created file watcher');
  assert.equal((await inspect()).annotations?.groups.find(item => item.id === group.id)?.files.length, countBeforeCreate, 'folder marks are a snapshot');

  const previousRevision = (await inspect()).graph.revision;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(mainUri, new vscode.Range(mainDocument.positionAt(0), mainDocument.positionAt(mainDocument.getText().length)), 'import { changed } from "./changed";\nexport const result = changed;\n');
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(mainDocument.isDirty, 'overlay is unsaved');
  const currentEditor = await vscode.window.showTextDocument(mainDocument, { preview: false });
  currentEditor.selection = new vscode.Selection(1, 0, 1, 0);
  await dispatch({ type: 'openEvidence', relationId: initialRelation.id });
  assert.equal(vscode.window.activeTextEditor?.selection.start.line, 1, 'stale graph opens file without imposing old import coordinates');
  state = await waitFor(snapshot => snapshot.graph.revision > previousRevision && snapshot.graph.relations.some(edge => edge.sourceId === main.id && edge.specifier === './changed'), 'unsaved document overlay');
  assert.ok(!state.graph.relations.some(edge => edge.sourceId === main.id && edge.specifier === '@/value'), 'old outgoing relation removed');
  assert.equal(state.annotations?.groups.find(item => item.id === group.id)?.relations.length, 1, 'missing relation mark preserved');
  assert.ok(await mainDocument.save());

  const marksBeforeRebuild = await fs.readFile(marksPath, 'utf8');
  await vscode.commands.executeCommand('dependencyMap.rebuild');
  assert.equal(await fs.readFile(marksPath, 'utf8'), marksBeforeRebuild, 'reindex does not rewrite annotations');
  await vscode.commands.executeCommand('dependencyMap.openProject');
  state = await inspect();
  assert.equal(state.view.mode, 'project');
  assert.ok(!JSON.stringify(state.graph).includes('INTEGRATION_SECRET_SENTINEL'));
  await dispatch({ type: 'cancel' });
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  const closedRevision = (await inspect()).graph.revision;
  await fs.writeFile(path.join(fixture, 'web', 'src', 'closed.ts'), 'export const afterClose = true;\n');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await inspect()).graph.revision, closedRevision, 'closed map does not spend CPU rebuilding the index');
  await vscode.commands.executeCommand('dependencyMap.openProject');
  await waitFor(value => value.graph.nodes.some(node => node.file?.path === 'src/closed.ts') && value.panelReady, 'reopening refreshes accumulated changes');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await dispatch({ type: 'setNodeDepth', nodeId: main.id, depth: 3 });
  await dispatch({ type: 'saveLocalState', state: { canvas: { zoom: 1.25, pan: { x: 12, y: 8 }, positions: { [main.id]: { x: 32, y: 64 } } }, panelSizes: { leftWidth: 260, rightWidth: 300, toolbarHeight: 110 }, showGroupColors: false } });
  assert.equal((await inspect()).localState?.canvas?.zoom, 1.25, 'local camera is stored in workspace state');
  console.log(`Dependency Map integration passed: ${state.graph.stats.files} files, ${state.graph.relations.length} relations, two roots, overlays, navigation, follow and shared annotations.`);
}
