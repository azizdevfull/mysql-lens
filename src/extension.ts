import * as vscode from 'vscode';
import { ConnectionStore } from './connections/store';
import { ConnectionManager } from './connections/manager';
import { SchemaService } from './schema';
import { ConnectionTree } from './tree/provider';
import { EditorSessions } from './query/editorSessions';
import { QueryHistory } from './query/history';
import { SqlCompletion } from './query/completion';
import { registerCommands } from './commands';

export function activate(ctx: vscode.ExtensionContext): void {
  const store = new ConnectionStore(ctx);
  const conns = new ConnectionManager(store);
  const schema = new SchemaService(conns);
  const tree = new ConnectionTree(store, conns, schema);
  const history = new QueryHistory(ctx);
  const sessions = new EditorSessions(ctx, store, conns, schema, history);

  const view = vscode.window.createTreeView('mysqlStudio.connections', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    showCollapseAll: true,
  });

  ctx.subscriptions.push(
    conns,
    sessions,
    view,
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, new SqlCompletion(sessions, schema), '.'),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mysqlStudio.showSystemDatabases')) {
        for (const c of store.list()) {
          schema.invalidate(c.id);
        }
        tree.refresh();
      }
    }),
    ...registerCommands({ ctx, store, conns, schema, tree, sessions, history }),
  );
}

export function deactivate(): void {}
