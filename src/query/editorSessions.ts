import * as vscode from 'vscode';
import * as mysql from 'mysql2';
import { ConnectionManager } from '../connections/manager';
import { ConnectionStore } from '../connections/store';
import { SchemaService } from '../schema';
import { ResultsPanel } from '../webviews/gridPanel';
import { errorText } from '../webviews/connectionForm';
import { splitSql, statementAt, Statement } from './splitter';
import { QueryHistory } from './history';

export interface Binding {
  connId: string;
  database?: string;
}

interface Session {
  conn?: mysql.Connection;
  /** connId|db the dedicated connection was opened for. */
  connKey?: string;
  results?: ResultsPanel;
}

const BINDINGS_KEY = 'mysqlLens.editorBindings';
const DDL = /^\s*(create|alter|drop|rename|truncate)\b/i;

/**
 * Ties SQL editors to a connection + database, keeps one dedicated MySQL
 * session per editor, and runs statements into a results panel.
 */
export class EditorSessions implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly status: vscode.StatusBarItem;
  private readonly flash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    isWholeLine: false,
  });
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeBinding = this.changed.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly conns: ConnectionManager,
    private readonly schema: SchemaService,
    private readonly history: QueryHistory,
  ) {
    this.status = vscode.window.createStatusBarItem('mysqlLens.editorConnection', vscode.StatusBarAlignment.Left, 100);
    this.status.name = 'MySQL Connection';
    this.status.command = 'mysqlLens.selectConnection';
    this.disposables.push(
      this.status,
      this.flash,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      vscode.workspace.onDidCloseTextDocument((d) => this.closeSession(d.uri.toString(), false)),
      store.onDidChange(() => this.updateStatus()),
      conns.onDidChangeState((id) => {
        // Pool went away: the dedicated connections belong to the same server session.
        if (!conns.isConnected(id)) {
          for (const [k, s] of this.sessions) {
            if (s.connKey?.startsWith(id + '|')) {
              s.conn?.destroy();
              this.sessions.set(k, { results: s.results });
            }
          }
        }
        this.updateStatus();
      }),
    );
    this.updateStatus();
  }

  binding(uri: vscode.Uri): Binding | undefined {
    const all = this.ctx.workspaceState.get<Record<string, Binding>>(BINDINGS_KEY, {});
    const b = all[uri.toString()];
    return b && this.store.get(b.connId) ? b : undefined;
  }

  async setBinding(uri: vscode.Uri, b: Binding | undefined): Promise<void> {
    const all = { ...this.ctx.workspaceState.get<Record<string, Binding>>(BINDINGS_KEY, {}) };
    if (b) {
      all[uri.toString()] = b;
    } else {
      delete all[uri.toString()];
    }
    await this.ctx.workspaceState.update(BINDINGS_KEY, all);
    this.updateStatus();
    this.changed.fire(uri);
  }

  updateStatus(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'sql') {
      this.status.hide();
      return;
    }
    const b = this.binding(ed.document.uri);
    if (!b) {
      this.status.text = '$(database) Select MySQL connection';
      this.status.tooltip = 'Choose the connection and database this editor runs against';
      this.status.backgroundColor = undefined;
    } else {
      const cfg = this.store.get(b.connId)!;
      const on = this.conns.isConnected(b.connId);
      this.status.text = `$(${on ? 'database' : 'circle-large-outline'}) ${cfg.name}${b.database ? ' › ' + b.database : ''}`;
      this.status.tooltip = `${cfg.user}@${cfg.host}:${cfg.port}${cfg.readOnly ? ' (read-only)' : ''}\nClick to change connection or database`;
      this.status.backgroundColor = cfg.color === 'charts.red' ? new vscode.ThemeColor('statusBarItem.errorBackground') : cfg.color === 'charts.yellow' || cfg.color === 'charts.orange' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }
    this.status.show();
  }

  /** Interactive picker: connection, then database. */
  async pickBinding(uri?: vscode.Uri, preset?: Binding): Promise<Binding | undefined> {
    let connId = preset?.connId;
    if (!connId) {
      const list = this.store.list();
      if (!list.length) {
        const add = await vscode.window.showInformationMessage('No MySQL connections yet.', 'Add Connection');
        if (add) {
          await vscode.commands.executeCommand('mysqlLens.addConnection');
        }
        return undefined;
      }
      const current = uri ? this.binding(uri) : undefined;
      const picked = await vscode.window.showQuickPick(
        list.map((c) => ({
          label: `$(${this.conns.isConnected(c.id) ? 'database' : 'circle-large-outline'}) ${c.name}`,
          description: `${c.user}@${c.host}:${c.port}`,
          detail: current?.connId === c.id ? 'Current' : undefined,
          id: c.id,
        })),
        { title: 'Select connection', placeHolder: 'Connection for this editor' },
      );
      if (!picked) {
        return undefined;
      }
      connId = picked.id;
    }
    let database = preset?.database;
    if (database === undefined) {
      let dbs: string[];
      try {
        dbs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Connecting…' }, () => this.schema.databases(connId!));
      } catch (e) {
        void vscode.window.showErrorMessage(`MySQL Lens: ${errorText(e)}`);
        return undefined;
      }
      const def = this.store.get(connId)?.database;
      const picked = await vscode.window.showQuickPick(
        [{ label: '$(circle-slash) No default database', db: '' }, ...dbs.map((d) => ({ label: `$(database) ${d}`, description: d === def ? 'default' : undefined, db: d }))],
        { title: 'Select database', placeHolder: 'Database used for unqualified table names' },
      );
      if (!picked) {
        return undefined;
      }
      database = picked.db || undefined;
    }
    const b = { connId, database };
    if (uri) {
      await this.setBinding(uri, b);
      this.closeSession(uri.toString(), true);
    }
    return b;
  }

  async newQuery(connId?: string, database?: string, content = ''): Promise<void> {
    const b = connId ? { connId, database: database ?? (this.store.get(connId)?.database || undefined) } : await this.pickBinding();
    if (!b) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await this.setBinding(doc.uri, b);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    if (content) {
      const end = doc.positionAt(content.length);
      ed.selection = new vscode.Selection(end, end);
    }
    this.updateStatus();
  }

  async run(mode: 'statement' | 'all'): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'sql') {
      void vscode.window.showWarningMessage('Open a SQL editor first.');
      return;
    }
    const doc = ed.document;
    let b = this.binding(doc.uri);
    if (!b) {
      b = await this.pickBinding(doc.uri);
      if (!b) {
        return;
      }
    }

    const text = doc.getText();
    let stmts: Statement[];
    let offset = 0;
    if (mode === 'all') {
      stmts = splitSql(text);
    } else if (!ed.selection.isEmpty) {
      offset = doc.offsetAt(ed.selection.start);
      stmts = splitSql(doc.getText(ed.selection));
    } else {
      const st = statementAt(text, doc.offsetAt(ed.selection.active));
      stmts = st ? [st] : [];
    }
    if (!stmts.length) {
      void vscode.window.showInformationMessage('Nothing to run.');
      return;
    }

    const flashRanges = stmts.map((s) => new vscode.Range(doc.positionAt(offset + s.start), doc.positionAt(offset + s.end)));
    ed.setDecorations(this.flash, flashRanges);
    setTimeout(() => ed.setDecorations(this.flash, []), 600);

    const sqls = stmts.map((s) => s.sql);
    if (!(await this.confirmDangerous(sqls))) {
      return;
    }
    await this.execute(doc.uri, b, sqls);
  }

  async rerun(panel: ResultsPanel): Promise<void> {
    for (const [k, s] of this.sessions) {
      if (s.results === panel && panel.rerunInfo) {
        const uri = vscode.Uri.parse(k);
        const b = this.binding(uri);
        if (b) {
          await this.execute(uri, b, panel.rerunInfo.statements);
        }
        return;
      }
    }
  }

  private async execute(uri: vscode.Uri, b: Binding, sqls: string[]): Promise<void> {
    const key = uri.toString();
    const session = this.sessions.get(key) ?? {};
    this.sessions.set(key, session);
    const cfg = this.store.get(b.connId)!;

    if (session.results?.isRunning) {
      session.results.reveal();
      void vscode.window.showWarningMessage('A query is still running for this editor.');
      return;
    }

    const connKey = `${b.connId}|${b.database ?? ''}`;
    if (!session.conn || session.connKey !== connKey) {
      session.conn?.destroy();
      session.conn = undefined;
      try {
        session.conn = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Connecting to ${cfg.name}…` }, () =>
          this.conns.dedicated(b.connId, b.database),
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`MySQL Lens: ${cfg.name}: ${errorText(e)}`);
        return;
      }
      session.connKey = connKey;
      const conn = session.conn;
      conn.on('error', () => {
        if (session.conn === conn) {
          session.conn = undefined;
        }
      });
      conn.on('end', () => {
        if (session.conn === conn) {
          session.conn = undefined;
        }
      });
    }

    if (!session.results) {
      const name = uri.scheme === 'untitled' ? uri.path : uri.path.split('/').pop();
      session.results = new ResultsPanel(this.ctx, this.conns, `Results: ${name}`, () => {
        if (this.sessions.get(key)) {
          this.sessions.get(key)!.results = undefined;
        }
      });
    } else {
      session.results.reveal();
    }

    let ddl = false;
    await session.results.run(
      { connId: b.connId, connName: cfg.name, database: b.database, conn: session.conn, readOnly: cfg.readOnly },
      sqls,
      (sql, ok, ms) => {
        void this.history.add({ sql, connName: cfg.name, database: b.database, at: Date.now(), ok, ms });
        if (ok && DDL.test(sql)) {
          ddl = true;
        }
        const use = /^\s*use\s+`?([^`;\s]+)`?/i.exec(sql);
        if (ok && use) {
          b = { connId: b.connId, database: use[1] };
          session.connKey = `${b.connId}|${b.database}`;
          void this.setBinding(uri, b);
        }
      },
    );
    if (ddl) {
      this.schema.invalidate(b.connId);
      void vscode.commands.executeCommand('mysqlLens.refresh');
    }
  }

  private async confirmDangerous(sqls: string[]): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('mysqlLens').get<boolean>('confirmDangerousQueries', true)) {
      return true;
    }
    const risky = sqls.filter((s) => {
      const t = s.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*/g, ' ').trim();
      if (/^(drop|truncate)\b/i.test(t)) {
        return true;
      }
      return /^(update|delete)\b/i.test(t) && !/\bwhere\b/i.test(t);
    });
    if (!risky.length) {
      return true;
    }
    const preview = risky.map((s) => s.replace(/\s+/g, ' ').slice(0, 200)).join('\n');
    const ok = await vscode.window.showWarningMessage(
      'This will change or delete data and cannot be undone.',
      { modal: true, detail: preview },
      'Run Anyway',
    );
    return ok === 'Run Anyway';
  }

  private closeSession(key: string, keepPanel: boolean): void {
    const s = this.sessions.get(key);
    if (!s) {
      return;
    }
    s.conn?.destroy();
    if (keepPanel) {
      this.sessions.set(key, { results: s.results });
    } else {
      this.sessions.delete(key);
    }
  }

  dispose(): void {
    for (const k of [...this.sessions.keys()]) {
      this.closeSession(k, false);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
