import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HostState, UiMessage, AnnotationResult } from '../shared/protocol';
import { isUiMessage, isSavedUiState } from '../shared/protocol';

export class MapPanel {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private latest?: HostState;
  private viewKey = '';
  constructor(private readonly extensionUri: vscode.Uri, private readonly onMessage: (message: UiMessage) => void, private readonly getLocalState: () => unknown = () => undefined) {}

  reveal(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
    const panel = vscode.window.createWebviewPanel('dependencyMap', 'Dependency Map', vscode.ViewColumn.Beside, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')]
    });
    this.panel = panel;
    const nonce = randomBytes(24).toString('hex');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'styles.css'));
    const local = this.getLocalState();
    const initial = JSON.stringify(isSavedUiState(local) ? local : {}).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    panel.webview.html = `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Dependency Map</title></head><body><script nonce="${nonce}">window.__dependencyMapInitialState=${initial};</script><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const messages = panel.webview.onDidReceiveMessage(value => {
      if (!isUiMessage(value)) return;
      if (value.type === 'ready') {
        this.ready = true;
        if (this.latest) void panel.webview.postMessage(this.latest);
      } else this.onMessage(value);
    });
    panel.onDidDispose(() => { messages.dispose(); this.panel = undefined; this.ready = false; });
  }

  update(state: HostState): void {
    const key = JSON.stringify(state.view);
    const statusOnly = this.latest?.graph === state.graph && this.viewKey === key && this.latest?.annotations === state.annotations && this.latest?.annotationError === state.annotationError;
    this.latest = state;
    this.viewKey = key;
    if (this.panel && this.ready) void this.panel.webview.postMessage(statusOnly ? { type: 'status', status: state.status, revision: state.graph.revision } : state);
  }

  dispose(): void { this.panel?.dispose(); }
  annotationResult(result: AnnotationResult): void {
    if (this.panel && this.ready) void this.panel.webview.postMessage(result);
  }
  isReady(): boolean { return this.ready; }
  isOpen(): boolean { return !!this.panel; }
}
