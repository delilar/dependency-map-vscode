import assert from 'node:assert/strict';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const project = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dependency-map-persistence-'));
try {
  const executable = process.env.VSCODE_EXECUTABLE_PATH ?? await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? '1.85.2');
  const extension = path.join(temporary, 'extension');
  const workspace = path.join(temporary, 'workspace');
  await mkdir(extension); await mkdir(workspace);
  for (const name of ['dist', 'schemas']) await cp(path.join(project, name), path.join(extension, name), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  manifest.main = './persistence-entry.cjs'; manifest.activationEvents = ['onStartupFinished'];
  await writeFile(path.join(extension, 'package.json'), JSON.stringify(manifest));
  await mkdir(path.join(workspace, '.vscode'));
  await writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none' }));
  await writeFile(path.join(workspace, 'index.ts'), 'export const value = 1;');
  await writeFile(path.join(extension, 'persistence-entry.cjs'), `
const vscode=require('vscode'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
exports.activate=async context=>{
 try {
  require('./dist/extension.cjs').activate(context);
  if(process.env.DEPENDENCY_MAP_PHASE==='seed'){
   await vscode.commands.executeCommand('dependencyMap.openProject');
   await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
   const seed=await vscode.commands.executeCommand('dependencyMap.inspect');
   const file=seed.graph.nodes.find(node=>node.file?.path==='index.ts');assert.ok(file);
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'ready',build:seed.analytics.runtime.host});
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'setNodeDepth',nodeId:file.id,depth:3});
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'saveLocalState',state:{canvas:{zoom:1.25,pan:{x:12,y:8}},query:'remember-camera',panelSizes:{leftWidth:260,rightWidth:300,toolbarHeight:110},showGroupColors:false}});
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'annotation',action:'createGroup',name:'Persistent task',color:'#00aa88'});
   const grouped=await vscode.commands.executeCommand('dependencyMap.inspect');
   const groupId=grouped.view.activeGroupId;assert.ok(groupId);
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'setView',view:{...grouped.view,mode:'file',focusId:file.id,follow:true}});
   const taskView=(await vscode.commands.executeCommand('dependencyMap.inspect')).view;
   const sharedPath=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'.vscode','dependency-map.json').fsPath;
   const before=await fs.readFile(sharedPath,'utf8');
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'taskContext',action:'save',groupId,data:{view:taskView,ui:{canvas:{zoom:1.75,pan:{x:37,y:29}},query:'task-view',panelSizes:{leftWidth:275},showGroupColors:true},branches:[],selection:{nodeIds:[file.id],relationIds:[]}}});
   const saved=await vscode.commands.executeCommand('dependencyMap.inspect');assert.ok(saved.analytics.taskContexts.savedGroupIds.includes(groupId));
   assert.equal(await fs.readFile(sharedPath,'utf8'),before,'Saving local task view must not write shared JSON');
  } else {
   await vscode.commands.executeCommand('dependencyMap.openProject');
   await new Promise(resolve=>setTimeout(resolve,750));
  }
  const state=await vscode.commands.executeCommand('dependencyMap.inspect');
  assert.equal(state.localState?.canvas?.zoom,1.25);assert.equal(state.localState?.query,'remember-camera');
  assert.equal(state.localState?.panelSizes?.leftWidth,260);assert.equal(state.localState?.panelSizes?.rightWidth,300);assert.equal(state.localState?.showGroupColors,false);
  const file=state.graph.nodes.find(node=>node.file?.path==='index.ts');assert.ok(file);assert.equal(state.view.nodeDepths?.[file.id],3);
  if(process.env.DEPENDENCY_MAP_PHASE==='restore'){
   const groupId=state.annotations.groups.find(group=>group.name==='Persistent task')?.id;assert.ok(groupId);
   assert.ok(state.analytics.taskContexts.savedGroupIds.includes(groupId),'Manual task point survives ordinary VS Code restart');
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'ready',build:state.analytics.runtime.host});
   const sharedPath=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'.vscode','dependency-map.json').fsPath;
   const before=await fs.readFile(sharedPath,'utf8');
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'taskContext',action:'preview',groupId});
   const preview=(await vscode.commands.executeCommand('dependencyMap.inspect')).analytics.taskContexts.preview;
   assert.ok(preview);assert.equal(preview.data.ui.query,'task-view','Saved task UI query must survive restart');assert.equal(preview.data.ui.canvas.zoom,1.75);assert.equal(preview.data.view.follow,false);assert.ok(preview.reasonCodes.includes('followPaused'));
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'taskContext',action:'restore',groupId});
   let restored=await vscode.commands.executeCommand('dependencyMap.inspect');
   const deadline=Date.now()+5000;
   while(restored.localState?.query!=='task-view'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,50));restored=await vscode.commands.executeCommand('dependencyMap.inspect');}
   assert.ok(restored.analytics.taskContexts.restore);assert.equal(restored.view.follow,false,'Task restore is pinned');
   assert.equal(restored.localState.query,'task-view','Restored task UI query must remain applied after Webview autosave');assert.equal(restored.localState.canvas.zoom,1.75);
   assert.equal(restored.localState.panelSizes.leftWidth,275);assert.equal(restored.view.nodeDepths[file.id],3);
   assert.equal(await fs.readFile(sharedPath,'utf8'),before,'Task preview and restore must preserve shared JSON byte-for-byte');
  }
  await fs.writeFile(process.env.DEPENDENCY_MAP_RESULT,JSON.stringify({phase:process.env.DEPENDENCY_MAP_PHASE,zoom:state.localState.canvas.zoom,ok:true}));
 }catch(error){await fs.writeFile(process.env.DEPENDENCY_MAP_RESULT,JSON.stringify({ok:false,error:String(error)}));}
 setTimeout(()=>vscode.commands.executeCommand('workbench.action.quit'),250);
};`);
  for (const phase of ['seed', 'restore']) {
    const resultFile = path.join(temporary, `${phase}.json`);
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [workspace, '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--skip-add-to-recently-opened', '--extensionDevelopmentPath', extension, '--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', path.join(temporary, 'extensions')], {
        env: { ...process.env, DEPENDENCY_MAP_TEST: '1', DEPENDENCY_MAP_PHASE: phase, DEPENDENCY_MAP_RESULT: resultFile }, windowsHide: true, stdio: 'ignore'
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Persistence ${phase} timed out`)); }, 55000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Editor exited ${code}`)); });
    });
    const result = JSON.parse(await readFile(resultFile, 'utf8'));
    assert.equal(result.ok, true, result.error);
    console.log(`Normal VS Code persistence ${phase}: zoom=${result.zoom}, query, panel sizes, group colors, node depth and manual task point verified; restore pinned and shared JSON unchanged.`);
  }
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temporary).startsWith('dependency-map-persistence-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
