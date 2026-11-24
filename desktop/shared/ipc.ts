/** IPC contract between the Electron main process and the shell renderer. */
import type { Node } from '../../src/core/treeModel';
import type { SchemaInfo } from '../../src/shared/protocol';
import type { PickItem } from '../../src/core/host';

export type { Node };

export interface TreeNode extends Node {
  /** Text shown in the tree. */
  text: string;
  icon: string;
  color?: string;
  expandable: boolean;
  connected?: boolean;
  error?: boolean;
}

export interface ConnSummary {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  database?: string;
  readOnly: boolean;
  description: string;
}

export type ViewSpec =
  | { kind: 'table'; connId: string; db: string; table: string; isView: boolean }
  | { kind: 'results'; tabId: string }
  | { kind: 'form'; id?: string; copyOf?: string }
  | { kind: 'import'; connId: string; db: string; table?: string };

export type RpcRequest =
  | { kind: 'toast'; level: 'info' | 'warn' | 'error'; message: string; actions: string[] }
  | { kind: 'pick'; title: string; placeholder?: string; many: boolean; items: PickItem[] }
  | { kind: 'input'; title: string; prompt?: string; value: string; password: boolean; error?: string };

/** main → shell */
export type ShellEvent =
  | { type: 'rpc'; id: number; req: RpcRequest }
  | { type: 'progress'; id: number; phase: 'start' | 'report' | 'end'; title?: string; message?: string; percent?: number }
  | { type: 'status'; message: string }
  | { type: 'treeChanged'; connId?: string }
  | { type: 'connections' }
  | { type: 'openTable'; connId: string; db: string; table: string; isView: boolean }
  | { type: 'openForm'; id?: string; copyOf?: string }
  | { type: 'openImport'; connId: string; db: string; table?: string }
  | { type: 'openSql'; text: string; language: string; connId?: string; db?: string; title?: string; path?: string }
  | { type: 'closeView'; viewId: string }
  | { type: 'setTitle'; viewId: string; title: string }
  | { type: 'refreshTables'; connId: string; db?: string }
  | { type: 'sqlBinding'; tabId: string; connId: string; db?: string }
  | { type: 'theme'; theme: 'dark' | 'light' };

export type Command =
  | 'connect'
  | 'disconnect'
  | 'refresh'
  | 'newConnection'
  | 'editConnection'
  | 'duplicateConnection'
  | 'deleteConnection'
  | 'createDatabase'
  | 'dropDatabase'
  | 'exportDatabase'
  | 'importSql'
  | 'importData'
  | 'openTable'
  | 'showDdl'
  | 'generateSelect'
  | 'generateInsert'
  | 'generateUpdate'
  | 'copyName'
  | 'exportTable'
  | 'truncateTable'
  | 'dropObject'
  | 'newQuery'
  | 'exportConnections'
  | 'importConnections'
  | 'history';

/** shell → main (invoke) */
export interface Api {
  'tree.roots'(): TreeNode[];
  'tree.children'(node: Node): TreeNode[];
  'tree.reorder'(ids: string[]): void;
  cmd(name: Command, node?: Node): void;
  'view.open'(viewId: string, spec: ViewSpec): void;
  'view.close'(viewId: string): void;
  'conn.list'(): ConnSummary[];
  'conn.databases'(connId: string): string[];
  'sql.run'(args: { tabId: string; connId: string; db?: string; statements: string[] }): void;
  'sql.cancel'(tabId: string): void;
  'sql.close'(tabId: string): void;
  'sql.schema'(connId: string, db: string): SchemaInfo | null;
  'sql.pickBinding'(tabId: string, connId?: string): { connId: string; db?: string } | null;
  'file.open'(): { path: string; text: string } | null;
  'file.save'(path: string | undefined, text: string): string | null;
  'rpc.reply'(id: number, value: unknown): void;
  'progress.cancel'(id: number): void;
  'settings.get'(): { theme: 'system' | 'dark' | 'light'; maxRows: number; pageSize: number; confirmDangerousQueries: boolean; showSystemDatabases: boolean };
  'settings.set'(patch: Record<string, unknown>): void;
  'app.info'(): { version: string; platform: string };
}

export type ApiName = keyof Api;
