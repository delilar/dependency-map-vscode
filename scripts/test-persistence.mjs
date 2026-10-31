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
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'setNodeDepth',nodeId:file.id,depth:3});
   await vscode.commands.executeCommand('dependencyMap.testMessage',{type:'saveLocalState',state:{canvas:{zoom:1.25,pan:{x:12,y:8}},query:'remember-camera',panelSizes:{leftWidth:260,rightWidth:300,toolbarHeight:110},showGroupColors:false}});
  } else {
   await vscode.commands.executeCommand('dependencyMap.openProject');
   await new Promise(resolve=>setTimeout(resolve,750));
  }
  const state=await vscode.commands.executeCommand('dependencyMap.inspect');
  assert.equal(state.localState?.canvas?.zoom,1.25);assert.equal(state.localState?.query,'remember-camera');
  assert.equal(state.localState?.panelSizes?.leftWidth,260);assert.equal(state.localState?.panelSizes?.rightWidth,300);assert.equal(state.localState?.showGroupColors,false);
  const file=state.graph.nodes.find(node=>node.file?.path==='index.ts');assert.ok(file);assert.equal(state.view.nodeDepths?.[file.id],3);
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
    console.log(`Normal VS Code persistence ${phase}: zoom=${result.zoom}, query, panel sizes, group colors and node depth restored.`);
  }
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temporary).startsWith('dependency-map-persistence-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
