import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/store';
import { ConnectionManager } from '../connections/manager';
import { describe } from '../connections/types';
import { SchemaService } from '../schema';
import { FOLDER_LABEL, Node, treeChildren } from '../core/treeModel';

export type { Node, NodeKind, FolderKind } from '../core/treeModel';


export class ConnectionTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = ['application/vnd.code.tree.mysqlstudio'];
  readonly dropMimeTypes = ['application/vnd.code.tree.mysqlstudio'];
  /** Errors shown inline under a connection after a failed connect. */
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly conns: ConnectionManager,
    private readonly schema: SchemaService,
  ) {
    store.onDidChange(() => this.refresh());
    conns.onDidChangeState(() => this.refresh());
  }

  refresh(node?: Node): void {
    this.changed.fire(node);
  }

  getParent(): undefined {
    return undefined;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'connection': {
        const cfg = this.store.get(n.connId)!;
        const on = this.conns.isConnected(n.connId);
        const item = new vscode.TreeItem(cfg.name, on ? C.Expanded : C.Collapsed);
        item.id = `c:${cfg.id}:${on ? 1 : 0}`;
        item.description = describe(cfg) + (cfg.readOnly ? ' · read-only' : '');
        item.iconPath = new vscode.ThemeIcon(on ? 'database' : 'circle-large-outline', cfg.color ? new vscode.ThemeColor(cfg.color) : undefined);
        item.contextValue = on ? 'connection.on' : 'connection.off';
        const err = this.errors.get(cfg.id);
        item.tooltip = new vscode.MarkdownString(
          `**${escapeMd(cfg.name)}**\n\n${escapeMd(describe(cfg))}` +
            (cfg.database ? `\n\nDefault database: \`${cfg.database}\`` : '') +
            (cfg.ssl.enabled ? '\n\nSSL enabled' : '') +
            (err ? `\n\n$(error) ${escapeMd(err)}` : ''),
          true,
        );
        return item;
      }
      case 'database': {
        const item = new vscode.TreeItem(n.db!, C.Collapsed);
        item.id = `d:${n.connId}:${n.db}`;
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'database';
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(n.label ?? FOLDER_LABEL[n.folder!], C.Collapsed);
        item.id = `f:${n.connId}:${n.db}:${n.table ?? ''}:${n.folder}`;
        item.description = n.description;
        item.iconPath = new vscode.ThemeIcon(
          { tables: 'folder', views: 'folder', procedures: 'symbol-method', functions: 'symbol-function', triggers: 'zap', indexes: 'list-tree' }[n.folder!],
        );
        item.contextValue = `folder.${n.folder}`;
        return item;
      }
      case 'table':
      case 'view': {
        const item = new vscode.TreeItem(n.name!, C.Collapsed);
        item.id = `t:${n.connId}:${n.db}:${n.name}`;
        item.iconPath = new vscode.ThemeIcon(n.kind === 'view' ? 'eye' : 'table');
        item.description = n.description;
        item.tooltip = n.tooltip;
        item.contextValue = n.kind;
        item.command = { command: 'mysqlLens.openTable', title: 'Open', arguments: [n] };
        return item;
      }
      case 'column': {
        const item = new vscode.TreeItem(n.name!, C.None);
        item.id = `col:${n.connId}:${n.db}:${n.table}:${n.name}`;
        item.description = n.description;
        item.tooltip = n.tooltip;
        item.iconPath = new vscode.ThemeIcon(n.pk ? 'key' : 'symbol-field', n.pk ? new vscode.ThemeColor('charts.yellow') : undefined);
        item.contextValue = 'column';
        return item;
      }
      case 'index': {
        const item = new vscode.TreeItem(n.name!, C.None);
        item.description = n.description;
        item.iconPath = new vscode.ThemeIcon('symbol-key');
        item.contextValue = 'index';
        return item;
      }
      case 'procedure':
      case 'function':
      case 'trigger': {
        const item = new vscode.TreeItem(n.name!, C.None);
        item.iconPath = new vscode.ThemeIcon(n.kind === 'trigger' ? 'zap' : n.kind === 'function' ? 'symbol-function' : 'symbol-method');
        item.contextValue = n.kind;
        item.command = { command: 'mysqlLens.showDdl', title: 'Show', arguments: [n] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(n.label ?? '', C.None);
        item.iconPath = new vscode.ThemeIcon(n.description === 'error' ? 'error' : 'info', n.description === 'error' ? new vscode.ThemeColor('errorForeground') : undefined);
        item.tooltip = n.tooltip;
        item.contextValue = 'message';
        return item;
      }
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) {
      return this.store.list().map((c) => ({ kind: 'connection', connId: c.id }));
    }
    try {
      const nodes = await this.children(n);
      if (n.kind === 'connection') {
        this.errors.delete(n.connId);
      }
      return nodes;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (n.kind === 'connection') {
        this.errors.set(n.connId, msg);
      }
      return [{ kind: 'message', connId: n.connId, label: msg, description: 'error', tooltip: msg }];
    }
  }

  private children(n: Node): Promise<Node[]> {
    return treeChildren(n, this.schema);
  }

  /* Drag and drop to reorder connections. */
  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const conns = source.filter((s) => s.kind === 'connection');
    if (conns.length) {
      data.set(this.dragMimeTypes[0], new vscode.DataTransferItem(conns.map((c) => c.connId)));
    }
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const ids = data.get(this.dragMimeTypes[0])?.value as string[] | undefined;
    if (!ids?.length) {
      return;
    }
    const order = this.store.list().map((c) => c.id).filter((id) => !ids.includes(id));
    const at = target ? order.indexOf(target.connId) : order.length;
    order.splice(at < 0 ? order.length : at, 0, ...ids);
    await this.store.reorder(order);
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
