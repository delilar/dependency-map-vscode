import * as vscode from 'vscode';
import { WorkspaceSession } from './host/workspace';
import { isUiMessage } from './shared/protocol';

export function activate(context: vscode.ExtensionContext): void {
  const session = new WorkspaceSession(context);
  context.subscriptions.push(session,
    vscode.commands.registerCommand('dependencyMap.openFile', (uri?: vscode.Uri) => session.open('file', uri)),
    vscode.commands.registerCommand('dependencyMap.openProject', () => session.open('project')),
    vscode.commands.registerCommand('dependencyMap.bindRoots', () => session.bindRoots()),
    vscode.commands.registerCommand('dependencyMap.rebuild', () => session.rebuild()),
    vscode.commands.registerCommand('dependencyMap.diagnostics', () => session.diagnostics())
  );
  if (process.env.DEPENDENCY_MAP_TEST === '1') context.subscriptions.push(
    vscode.commands.registerCommand('dependencyMap.inspect', () => session.inspect()),
    vscode.commands.registerCommand('dependencyMap.testMessage', (message: unknown) => { if (isUiMessage(message)) return session.testMessage(message); })
  );
}
