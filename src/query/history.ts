import * as vscode from 'vscode';

export interface HistoryEntry {
  sql: string;
  connName: string;
  database?: string;
  at: number;
  ok: boolean;
  ms: number;
}

const KEY = 'mysqlLens.history';

export class QueryHistory {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  list(): HistoryEntry[] {
    return this.ctx.globalState.get<HistoryEntry[]>(KEY, []);
  }

  async add(e: HistoryEntry): Promise<void> {
    const max = vscode.workspace.getConfiguration('mysqlLens').get<number>('historySize', 500);
    const all = this.list().filter((x) => !(x.sql === e.sql && x.connName === e.connName));
    all.unshift(e);
    await this.ctx.globalState.update(KEY, all.slice(0, max));
  }

  async clear(): Promise<void> {
    await this.ctx.globalState.update(KEY, []);
  }

  async show(): Promise<void> {
    const entries = this.list();
    if (!entries.length) {
      void vscode.window.showInformationMessage('Query history is empty.');
      return;
    }
    const clear: vscode.QuickPickItem = { label: '$(trash) Clear history', alwaysShow: true };
    const items = entries.map((e) => ({
      label: `${e.ok ? '$(check)' : '$(error)'} ${e.sql.replace(/\s+/g, ' ').slice(0, 140)}`,
      description: `${e.connName}${e.database ? ' › ' + e.database : ''}`,
      detail: `${new Date(e.at).toLocaleString()} · ${e.ms} ms`,
      entry: e,
    }));
    const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { entry?: HistoryEntry }>([...items, { label: '', kind: vscode.QuickPickItemKind.Separator }, clear], {
      title: 'Query History',
      placeHolder: 'Search executed queries — select one to open it in a new editor',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }
    if (picked === clear) {
      await this.clear();
      return;
    }
    if (picked.entry) {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: picked.entry.sql.trimEnd() + ';\n' });
      await vscode.window.showTextDocument(doc);
    }
  }
}
