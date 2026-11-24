import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { SchemaService } from '../schema';
import { ImportController } from '../core/importController';
import type { UiHost } from '../core/host';
import type { ImportToExtension, ImportToWebview } from '../shared/protocol';
import { webviewHtml, webviewOptions } from './html';

/** Wizard: pick a CSV/JSON/Excel file, map columns, import into a table. */
export function showImportPanel(
  ctx: vscode.ExtensionContext,
  host: UiHost,
  conns: ConnectionManager,
  schema: SchemaService,
  connId: string,
  db: string,
  table: string | undefined,
  onDone: () => void,
): void {
  const panel = vscode.window.createWebviewPanel('mysqlLens.import', `Import into ${db}`, vscode.ViewColumn.Active, webviewOptions(ctx.extensionUri));
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.svg');
  panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, 'importer', 'Import');
  const controller = new ImportController(host, (m: ImportToWebview) => void panel.webview.postMessage(m), conns, schema, connId, db, table, {
    setTitle: (t) => (panel.title = t),
    close: () => panel.dispose(),
    openTable: (t) => void vscode.commands.executeCommand('mysqlLens.openTable', { kind: 'table', connId, db, name: t }),
    done: onDone,
  });
  panel.onDidDispose(() => controller.dispose());
  panel.webview.onDidReceiveMessage((m: ImportToExtension) => void controller.receive(m));
}
