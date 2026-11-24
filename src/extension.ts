import * as vscode from 'vscode';
import { ConnectionStore } from './connections/store';
import { ConnectionManager } from './connections/manager';
import { SchemaService } from './schema';
import { ConnectionTree } from './tree/provider';
import { EditorSessions } from './query/editorSessions';
import { QueryHistory } from './query/history';
import { SqlCompletion } from './query/completion';
import { registerCommands } from './commands';
import { VscodeHost } from './vscodeHost';

export function activate(ctx: vscode.ExtensionContext): void {
  const host = new VscodeHost();
  const store = new ConnectionStore(ctx);
  const conns = new ConnectionManager(store, {
    askSecret: async (prompt) => {
      const v = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
      if (v === undefined) {
        throw new Error('Cancelled.');
      }
      return v;
    },
    onTunnelClosed: (name) => void vscode.window.showWarningMessage(`MySQL Lens: SSH tunnel for "${name}" closed.`),
  });
  const schema = new SchemaService(conns, () => host.settings().showSystemDatabases);
  const tree = new ConnectionTree(store, conns, schema);
  const history = new QueryHistory(ctx);
  const sessions = new EditorSessions(ctx, host, store, conns, schema, history);

  const view = vscode.window.createTreeView('mysqlLens.connections', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    showCollapseAll: true,
  });

  ctx.subscriptions.push(
    { dispose: () => conns.dispose() },
    sessions,
    view,
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, new SqlCompletion(sessions, schema), '.'),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mysqlLens.showSystemDatabases')) {
        for (const c of store.list()) {
          schema.invalidate(c.id);
        }
        tree.refresh();
      }
    }),
    ...registerCommands({ ctx, host, store, conns, schema, tree, sessions, history }),
  );
}

export function deactivate(): void {}
