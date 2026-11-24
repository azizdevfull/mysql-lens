import * as vscode from 'vscode';
import { ConnectionStore } from '../connections/store';
import { ConnectionManager } from '../connections/manager';
import { describe } from '../connections/types';
import { SchemaService } from '../schema';
import { formatBytes, formatCount } from '../sql';

export type NodeKind =
  | 'connection'
  | 'database'
  | 'folder'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'message';

export type FolderKind = 'tables' | 'views' | 'procedures' | 'functions' | 'triggers' | 'indexes';

export interface Node {
  kind: NodeKind;
  connId: string;
  db?: string;
  /** Table/view/routine/trigger/column name. */
  name?: string;
  /** Owning table for columns and indexes. */
  table?: string;
  folder?: FolderKind;
  label?: string;
  description?: string;
  tooltip?: string;
  pk?: boolean;
}

const FOLDER_LABEL: Record<FolderKind, string> = {
  tables: 'Tables',
  views: 'Views',
  procedures: 'Procedures',
  functions: 'Functions',
  triggers: 'Triggers',
  indexes: 'Indexes',
};

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

  private async children(n: Node): Promise<Node[]> {
    const { connId, db } = n;
    switch (n.kind) {
      case 'connection': {
        const dbs = await this.schema.databases(connId);
        if (!dbs.length) {
          return [{ kind: 'message', connId, label: 'No databases' }];
        }
        return dbs.map((d) => ({ kind: 'database', connId, db: d }));
      }
      case 'database': {
        const [tables, routines, triggers] = await Promise.all([
          this.schema.tables(connId, db!),
          this.schema.routines(connId, db!),
          this.schema.triggers(connId, db!),
        ]);
        const tableCount = tables.filter((t) => t.kind === 'table').length;
        const viewCount = tables.length - tableCount;
        const procs = routines.filter((r) => r.kind === 'procedure').length;
        const funcs = routines.length - procs;
        const out: Node[] = [{ kind: 'folder', connId, db, folder: 'tables', description: String(tableCount) }];
        if (viewCount) { out.push({ kind: 'folder', connId, db, folder: 'views', description: String(viewCount) }); }
        if (procs) { out.push({ kind: 'folder', connId, db, folder: 'procedures', description: String(procs) }); }
        if (funcs) { out.push({ kind: 'folder', connId, db, folder: 'functions', description: String(funcs) }); }
        if (triggers.length) { out.push({ kind: 'folder', connId, db, folder: 'triggers', description: String(triggers.length) }); }
        return out;
      }
      case 'folder': {
        switch (n.folder) {
          case 'tables':
          case 'views': {
            const kind = n.folder === 'tables' ? 'table' : 'view';
            const tables = (await this.schema.tables(connId, db!)).filter((t) => t.kind === kind);
            return tables.map((t) => ({
              kind,
              connId,
              db,
              name: t.name,
              description: kind === 'table' ? [t.rows !== null ? `~${formatCount(t.rows)} rows` : '', t.dataBytes ? formatBytes(t.dataBytes) : ''].filter(Boolean).join(' · ') : undefined,
              tooltip: [t.name, t.engine ? `Engine: ${t.engine}` : '', t.comment].filter(Boolean).join('\n'),
            }));
          }
          case 'procedures':
          case 'functions': {
            const kind = n.folder === 'procedures' ? 'procedure' : 'function';
            return (await this.schema.routines(connId, db!)).filter((r) => r.kind === kind).map((r) => ({ kind, connId, db, name: r.name }));
          }
          case 'triggers':
            return (await this.schema.triggers(connId, db!)).map((t) => ({ kind: 'trigger', connId, db, name: t }));
          case 'indexes':
            return (await this.schema.indexes(connId, db!, n.table!)).map((i) => ({
              kind: 'index',
              connId,
              db,
              table: n.table,
              name: i.name,
              description: `${i.unique ? 'UNIQUE ' : ''}(${i.columns.join(', ')})`,
            }));
        }
        return [];
      }
      case 'table':
      case 'view': {
        const cols = await this.schema.columns(connId, db!, n.name!);
        const nodes: Node[] = cols.map((c) => ({
          kind: 'column',
          connId,
          db,
          table: n.name,
          name: c.name,
          pk: c.key === 'PRI',
          description: `${c.columnType}${c.nullable ? '' : ' NOT NULL'}${c.extra ? ' ' + c.extra : ''}`,
          tooltip: [
            `${c.name} ${c.columnType}`,
            c.nullable ? 'NULL' : 'NOT NULL',
            c.defaultValue !== null ? `DEFAULT ${c.defaultValue}` : '',
            c.extra,
            c.comment ? `— ${c.comment}` : '',
          ].filter(Boolean).join(' '),
        }));
        if (n.kind === 'table') {
          const idx = await this.schema.indexes(connId, db!, n.name!);
          if (idx.length) {
            nodes.push({ kind: 'folder', connId, db, table: n.name, folder: 'indexes', description: String(idx.length) });
          }
        }
        return nodes;
      }
      default:
        return [];
    }
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
