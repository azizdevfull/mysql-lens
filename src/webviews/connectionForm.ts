import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { ConnectionFormController } from '../core/formController';
import type { ConnectionStoreLike } from '../core/flows';
import type { UiHost } from '../core/host';
import type { FormToExtension, FormToWebview } from '../shared/protocol';
import { webviewHtml, webviewOptions } from './html';

export { errorText } from '../core/errors';

const open = new Map<string, vscode.WebviewPanel>();

/** Opens the add/edit connection form. `id` edits an existing connection; `copyOf` duplicates one. */
export function showConnectionForm(
  ctx: vscode.ExtensionContext,
  host: UiHost,
  store: ConnectionStoreLike,
  conns: ConnectionManager,
  opts: { id?: string; copyOf?: string } = {},
): void {
  const key = opts.id ?? `new-${Date.now()}`;
  const existing = open.get(key);
  if (existing) {
    existing.reveal();
    return;
  }
  let panel: vscode.WebviewPanel | undefined;
  const controller = new ConnectionFormController(host, (m: FormToWebview) => void panel?.webview.postMessage(m), store, conns, opts, () => panel?.dispose());
  panel = vscode.window.createWebviewPanel('mysqlLens.connection', controller.title, vscode.ViewColumn.Active, webviewOptions(ctx.extensionUri));
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.svg');
  panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, 'connection', 'Connection');
  open.set(key, panel);
  panel.onDidDispose(() => open.delete(key));
  panel.webview.onDidReceiveMessage((m: FormToExtension) => void controller.receive(m));
}
