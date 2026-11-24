import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { SchemaService } from '../schema';
import type { GridToExtension, GridToWebview } from '../shared/protocol';
import { GridController, ResultsController, RunTarget, TableController } from '../core/gridControllers';
import type { UiHost } from '../core/host';
import { webviewHtml, webviewOptions } from './html';

export type { RunTarget };

function createGridPanel(ctx: vscode.ExtensionContext, viewType: string, title: string, icon: string, column: vscode.ViewColumn): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(viewType, title, { viewColumn: column, preserveFocus: true }, webviewOptions(ctx.extensionUri));
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', `${icon}.svg`);
  panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, 'grid', title);
  return panel;
}

function wire(panel: vscode.WebviewPanel, controller: GridController, onDispose?: () => void): void {
  panel.webview.onDidReceiveMessage((m: GridToExtension) => void controller.receive(m));
  panel.onDidDispose(() => {
    controller.dispose();
    onDispose?.();
  });
}

/** Results of SQL run from an editor. */
export class ResultsPanel {
  readonly panel: vscode.WebviewPanel;
  readonly controller: ResultsController;

  constructor(ctx: vscode.ExtensionContext, host: UiHost, conns: ConnectionManager, title: string, onClosed: () => void) {
    this.panel = createGridPanel(ctx, 'mysqlLens.results', title, 'panel', vscode.ViewColumn.Beside);
    const post = (m: GridToWebview) => void this.panel.webview.postMessage(m);
    this.controller = new ResultsController(host, post, conns, () => void vscode.commands.executeCommand('mysqlLens.rerun', this));
    wire(this.panel, this.controller, onClosed);
  }

  get isRunning(): boolean {
    return this.controller.isRunning;
  }

  get rerunInfo() {
    return this.controller.rerunInfo;
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  run(...args: Parameters<ResultsController['run']>): Promise<void> {
    return this.controller.run(...args);
  }
}

/** Table data editor, one per table. */
export class TablePanel {
  private static readonly open_ = new Map<string, TablePanel>();
  readonly panel: vscode.WebviewPanel;
  readonly controller: TableController;

  static open(ctx: vscode.ExtensionContext, host: UiHost, conns: ConnectionManager, schema: SchemaService, connId: string, db: string, table: string, isView: boolean): void {
    const key = `${connId}|${db}|${table}`;
    const existing = TablePanel.open_.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    TablePanel.open_.set(key, new TablePanel(ctx, host, conns, schema, connId, db, table, isView, () => TablePanel.open_.delete(key)));
  }

  static refreshAll(connId: string, db?: string): void {
    for (const [k, p] of TablePanel.open_) {
      if (k.startsWith(`${connId}|${db ?? ''}`)) {
        void p.controller.load();
      }
    }
  }

  private constructor(
    ctx: vscode.ExtensionContext,
    host: UiHost,
    conns: ConnectionManager,
    schema: SchemaService,
    connId: string,
    db: string,
    table: string,
    isView: boolean,
    onClosed: () => void,
  ) {
    this.panel = createGridPanel(ctx, 'mysqlLens.table', table, 'table', vscode.ViewColumn.Active);
    const post = (m: GridToWebview) => void this.panel.webview.postMessage(m);
    this.controller = new TableController(host, post, conns, schema, connId, db, table, isView);
    wire(this.panel, this.controller, onClosed);
  }
}
