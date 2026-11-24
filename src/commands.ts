import * as vscode from 'vscode';
import { ConnectionStore } from './connections/store';
import { ConnectionManager } from './connections/manager';
import { SchemaService } from './schema';
import { ConnectionTree, Node } from './tree/provider';
import { EditorSessions } from './query/editorSessions';
import { QueryHistory } from './query/history';
import { showConnectionForm } from './webviews/connectionForm';
import { ResultsPanel, TablePanel } from './webviews/gridPanel';
import { showImportPanel } from './webviews/importPanel';
import * as flows from './core/flows';
import { errorText } from './core/errors';
import type { UiHost } from './core/host';

interface Deps {
  ctx: vscode.ExtensionContext;
  host: UiHost;
  store: ConnectionStore;
  conns: ConnectionManager;
  schema: SchemaService;
  tree: ConnectionTree;
  sessions: EditorSessions;
  history: QueryHistory;
}

export function registerCommands(d: Deps): vscode.Disposable[] {
  const { ctx, host, store, conns, schema, tree, sessions, history } = d;
  const fctx: flows.Ctx = { host, conns, schema, store };

  const refreshAll = () => {
    for (const c of store.list()) {
      schema.invalidate(c.id);
    }
    tree.refresh();
  };

  /** Resolves connection + database from a tree node, or asks. */
  const target = async (n?: Node, needDb = true): Promise<{ connId: string; db?: string } | undefined> => {
    if (n?.connId && (n.db || !needDb)) {
      return { connId: n.connId, db: n.db };
    }
    const ed = vscode.window.activeTextEditor;
    const bound = ed ? sessions.binding(ed.document.uri) : undefined;
    if (bound && (bound.database || !needDb) && !n) {
      return { connId: bound.connId, db: bound.database };
    }
    const b = await sessions.pickBinding(undefined, n?.connId ? { connId: n.connId } : undefined);
    if (!b) {
      return undefined;
    }
    if (needDb && !b.database) {
      void vscode.window.showWarningMessage('Choose a database.');
      return undefined;
    }
    return { connId: b.connId, db: b.database };
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        host.error(errorText(e));
      }
    });

  const openSql = async (n: Node, kind: 'select' | 'insert' | 'update') => sessions.newQuery(n.connId, n.db, await flows.sqlTemplate(fctx, kind, n.connId, n.db!, n.name!));

  return [
    reg('mysqlLens.addConnection', () => showConnectionForm(ctx, host, store, conns)),
    reg('mysqlLens.editConnection', (n: Node) => showConnectionForm(ctx, host, store, conns, { id: n.connId })),
    reg('mysqlLens.duplicateConnection', (n: Node) => showConnectionForm(ctx, host, store, conns, { copyOf: n.connId })),
    reg('mysqlLens.deleteConnection', (n: Node) => flows.deleteConnection(fctx, n.connId)),
    reg('mysqlLens.refresh', (n?: Node) => {
      if (n?.connId) {
        schema.invalidate(n.connId, n.db);
        tree.refresh(n.kind === 'connection' || n.kind === 'database' ? n : undefined);
      } else {
        refreshAll();
      }
    }),
    reg('mysqlLens.connect', async (n: Node) => {
      await vscode.window.withProgress({ location: { viewId: 'mysqlLens.connections' }, title: 'Connecting…' }, () => conns.connect(n.connId));
    }),
    reg('mysqlLens.disconnect', (n: Node) => conns.disconnect(n.connId)),

    reg('mysqlLens.newQuery', (n?: Node) => sessions.newQuery(n?.connId, n?.db)),
    reg('mysqlLens.runStatement', () => sessions.run('statement')),
    reg('mysqlLens.runAll', () => sessions.run('all')),
    reg('mysqlLens.rerun', (p: ResultsPanel) => sessions.rerun(p)),
    reg('mysqlLens.selectConnection', () => {
      const ed = vscode.window.activeTextEditor;
      return ed ? sessions.pickBinding(ed.document.uri) : sessions.newQuery();
    }),
    reg('mysqlLens.queryHistory', () => history.show()),

    reg('mysqlLens.openTable', (n: Node) => TablePanel.open(ctx, host, conns, schema, n.connId, n.db!, n.name!, n.kind === 'view')),
    reg('mysqlLens.showDdl', async (n: Node) => {
      const sql = await schema.createStatement(n.connId, n.db!, n.kind, n.name!);
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: (sql || `-- No definition available for ${n.name}`) + ';\n' });
      await sessions.setBinding(doc.uri, { connId: n.connId, database: n.db });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    reg('mysqlLens.generateSelect', (n: Node) => openSql(n, 'select')),
    reg('mysqlLens.generateInsert', (n: Node) => openSql(n, 'insert')),
    reg('mysqlLens.generateUpdate', (n: Node) => openSql(n, 'update')),
    reg('mysqlLens.copyName', async (n: Node) => {
      await host.copy(n.kind === 'database' ? n.db! : n.name!);
    }),

    reg('mysqlLens.createDatabase', async (n?: Node) => {
      const t = await target(n, false);
      if (t && (await flows.createDatabase(fctx, t.connId))) tree.refresh();
    }),
    reg('mysqlLens.dropDatabase', async (n: Node) => {
      if (await flows.dropDatabase(fctx, n.connId, n.db!)) tree.refresh();
    }),
    reg('mysqlLens.truncateTable', async (n: Node) => {
      if (await flows.truncateTable(fctx, n.connId, n.db!, n.name!)) {
        tree.refresh();
        TablePanel.refreshAll(n.connId, n.db);
      }
    }),
    reg('mysqlLens.dropObject', async (n: Node) => {
      if (await flows.dropObject(fctx, n.kind, n.connId, n.db!, n.name!)) tree.refresh();
    }),

    reg('mysqlLens.exportTable', (n: Node) => flows.exportTable(fctx, n.connId, n.db!, n.name!)),
    reg('mysqlLens.exportDatabase', async (n?: Node) => {
      const t = await target(n);
      if (t?.db) await flows.exportDatabase(fctx, t.connId, t.db);
    }),
    reg('mysqlLens.importSql', async (n?: Node) => {
      const t = await target(n, false);
      if (t && (await flows.importSql(fctx, t.connId, t.db))) tree.refresh();
    }),
    reg('mysqlLens.importData', async (n?: Node) => {
      const t = await target(n);
      if (!t?.db) {
        return;
      }
      showImportPanel(ctx, host, conns, schema, t.connId, t.db, n?.kind === 'table' ? n.name : undefined, () => {
        tree.refresh();
        TablePanel.refreshAll(t.connId, t.db);
      });
    }),

    reg('mysqlLens.exportConnections', () => flows.exportConnections(fctx)),
    reg('mysqlLens.importConnections', () => flows.importConnections(fctx)),
  ];
}
