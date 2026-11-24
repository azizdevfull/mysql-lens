import * as vscode from 'vscode';
import * as mysql from 'mysql2';
import { ConnectionManager, runQuery } from '../connections/manager';
import { SchemaService } from '../schema';
import type { Cell, ColumnInfo, ExportFormat, GridToExtension, GridToWebview, ResultSet, RowChange, SortSpec, TablePage } from '../shared/protocol';
import { cellLiteral, qid, qualified, toCell } from '../sql';
import { executeStatement, killQuery } from '../query/executor';
import { splitSql } from '../query/splitter';
import { buildTableQuery, parseTableQuery } from '../query/tableQuery';
import { exportCell, streamQuery } from '../io/exporters';
import { pickSaveFile, writeExport } from '../io/exportFlow';
import { errorText } from './connectionForm';
import { webviewHtml, webviewOptions } from './html';

abstract class GridPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private readyResolve!: () => void;
  protected readonly ready = new Promise<void>((r) => (this.readyResolve = r));
  protected disposed = false;

  constructor(
    protected readonly ctx: vscode.ExtensionContext,
    viewType: string,
    title: string,
    icon: string,
    column: vscode.ViewColumn,
  ) {
    this.panel = vscode.window.createWebviewPanel(viewType, title, { viewColumn: column, preserveFocus: true }, webviewOptions(ctx.extensionUri));
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', `${icon}.svg`);
    this.panel.webview.html = webviewHtml(this.panel.webview, ctx.extensionUri, 'grid', title);
    this.panel.webview.onDidReceiveMessage((m: GridToExtension) => this.onMessage(m).catch((e) => this.notifyError(e)));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.onDispose();
    });
  }

  protected post(m: GridToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(m);
    }
  }

  protected notifyError(e: unknown): void {
    void vscode.window.showErrorMessage(`MySQL Lens: ${errorText(e)}`);
  }

  private async onMessage(m: GridToExtension): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.readyResolve();
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('$(check) Copied to clipboard', 2000);
        return;
      case 'openText': {
        const doc = await vscode.workspace.openTextDocument({ content: m.text, language: m.language });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        return;
      }
      case 'notify': {
        const fn = m.level === 'error' ? vscode.window.showErrorMessage : m.level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        void fn(m.message);
        return;
      }
      default:
        await this.handle(m);
    }
  }

  protected abstract handle(m: GridToExtension): Promise<void>;
  protected onDispose(): void {}

  dispose(): void {
    this.panel.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Query results                                                        */
/* ------------------------------------------------------------------ */

export interface RunTarget {
  connId: string;
  connName: string;
  database: string | undefined;
  conn: mysql.Connection;
  readOnly: boolean;
}

export class ResultsPanel extends GridPanel {
  private results: ResultSet[] = [];
  private running = false;
  private cancelled = false;
  private lastRun?: { target: RunTarget; statements: string[] };

  constructor(
    ctx: vscode.ExtensionContext,
    private readonly conns: ConnectionManager,
    title: string,
    private readonly onClosed: () => void,
  ) {
    super(ctx, 'mysqlLens.results', title, 'panel', vscode.ViewColumn.Beside);
  }

  get isRunning(): boolean {
    return this.running;
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  async run(target: RunTarget, statements: string[], onExecuted: (sql: string, ok: boolean, ms: number) => void): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage('A query is already running in this editor. Cancel it first.');
      return;
    }
    await this.ready;
    this.lastRun = { target, statements };
    this.running = true;
    this.cancelled = false;
    this.results = [];
    const maxRows = vscode.workspace.getConfiguration('mysqlLens').get<number>('maxRows', 5000);
    this.post({
      type: 'init',
      mode: 'results',
      title: target.connName + (target.database ? ` › ${target.database}` : ''),
      subtitle: statements.length === 1 ? firstLine(statements[0]) : `${statements.length} statements`,
      readOnly: target.readOnly,
    });
    this.post({ type: 'running', label: statements.length === 1 ? 'Running query…' : `Running ${statements.length} statements…`, statementCount: statements.length });
    const started = Date.now();
    try {
      for (const sql of statements) {
        if (this.cancelled || this.disposed) {
          break;
        }
        const res = await executeStatement(target.conn, sql, maxRows);
        for (const r of res) {
          this.results.push(r);
          this.post({ type: 'result', result: r });
        }
        const failed = res.some((r) => r.kind === 'error');
        onExecuted(sql, !failed, res[0]?.durationMs ?? 0);
        if (failed) {
          break;
        }
      }
    } finally {
      this.running = false;
      this.post({ type: 'done', cancelled: this.cancelled, durationMs: Date.now() - started });
    }
  }

  protected async handle(m: GridToExtension): Promise<void> {
    switch (m.type) {
      case 'cancel':
        if (this.running && this.lastRun) {
          this.cancelled = true;
          const pool = await this.conns.pool(this.lastRun.target.connId);
          await killQuery(pool, this.lastRun.target.conn.threadId ?? 0);
        }
        return;
      case 'rerun':
        if (this.lastRun) {
          await vscode.commands.executeCommand('mysqlLens.rerun', this);
        }
        return;
      case 'export':
        await this.exportResult(m.resultId, m.format);
        return;
    }
  }

  get rerunInfo() {
    return this.lastRun;
  }

  private async exportResult(id: number | undefined, format: ExportFormat): Promise<void> {
    const r = this.results.find((x) => x.id === id) ?? this.results.find((x) => x.kind === 'rows');
    if (!r || r.kind !== 'rows') {
      return;
    }
    let full = false;
    if (r.truncated && /^\s*(select|with|show|\(|table|values)/i.test(r.sql)) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: `Export the ${r.rows.length.toLocaleString()} loaded rows`, full: false },
          { label: `Re-run the query and export all ${r.totalRows.toLocaleString()} rows`, full: true },
        ],
        { title: 'The result was truncated' },
      );
      if (!choice) {
        return;
      }
      full = choice.full;
    }
    const table = r.columns[0]?.table || 'result';
    const file = await pickSaveFile(format, table);
    if (!file || !this.lastRun) {
      return;
    }
    if (!full) {
      await writeExport({ format, file, tableName: table, columns: async () => r.columns, rows: r.rows, total: r.rows.length });
      return;
    }
    const conn = await this.conns.dedicated(this.lastRun.target.connId, this.lastRun.target.database);
    try {
      const s = streamQuery(conn, r.sql);
      await writeExport({
        format,
        file,
        tableName: table,
        columns: () => s.columns,
        rows: mapRows(s.rows),
        total: r.totalRows,
        onCancel: () => conn.destroy(),
      });
    } finally {
      conn.destroy();
    }
  }

  protected onDispose(): void {
    this.onClosed();
  }
}

/* ------------------------------------------------------------------ */
/* Table data editor                                                    */
/* ------------------------------------------------------------------ */

const tablePanels = new Map<string, TablePanel>();

export class TablePanel extends GridPanel {
  private columns: ColumnInfo[] = [];
  private keyColumns: string[] = [];
  private state: { page: number; pageSize: number; sort: SortSpec | null; filter: string };
  private readonly key: string;
  /** Free-form query currently shown instead of table paging. */
  private customSql: string | null = null;
  /** Dedicated session for free-form queries (keeps USE / SET between runs). */
  private session?: mysql.Connection;

  static open(ctx: vscode.ExtensionContext, conns: ConnectionManager, schema: SchemaService, connId: string, db: string, table: string, isView: boolean): void {
    const key = `${connId}|${db}|${table}`;
    const existing = tablePanels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const p = new TablePanel(ctx, conns, schema, connId, db, table, isView, key);
    tablePanels.set(key, p);
  }

  static refreshAll(connId: string, db?: string): void {
    for (const [k, p] of tablePanels) {
      if (k.startsWith(`${connId}|${db ?? ''}`)) {
        void p.load();
      }
    }
  }

  private constructor(
    ctx: vscode.ExtensionContext,
    private readonly conns: ConnectionManager,
    private readonly schema: SchemaService,
    private readonly connId: string,
    private readonly db: string,
    private readonly table: string,
    private readonly isView: boolean,
    key: string,
  ) {
    super(ctx, 'mysqlLens.table', table, 'table', vscode.ViewColumn.Active);
    this.key = key;
    this.state = {
      page: 0,
      pageSize: vscode.workspace.getConfiguration('mysqlLens').get<number>('pageSize', 200),
      sort: null,
      filter: '',
    };
    void this.init();
  }

  private async init(): Promise<void> {
    await this.ready;
    const cfg = this.conns.config(this.connId);
    this.post({ type: 'init', mode: 'table', title: `${this.db}.${this.table}`, subtitle: cfg.name, readOnly: cfg.readOnly || this.isView });
    await this.load();
    void this.sendSchema();
  }

  private async sendSchema(): Promise<void> {
    try {
      const [tables, cols] = await Promise.all([this.schema.tables(this.connId, this.db), this.schema.allColumns(this.connId, this.db)]);
      this.post({
        type: 'schema',
        schema: { database: this.db, table: this.table, tables: tables.map((t) => t.name), columns: Object.fromEntries(cols) },
      });
    } catch {
      // Autocomplete falls back to keywords.
    }
  }

  /** Runs SQL typed in the panel's query editor. */
  private async runQuery(sql: string): Promise<void> {
    const pageSize = vscode.workspace.getConfiguration('mysqlLens').get<number>('pageSize', 200);
    const simple = parseTableQuery(sql, this.db, this.table, pageSize);
    if (simple) {
      this.customSql = null;
      this.state = simple;
      await this.load();
      return;
    }
    const statements = splitSql(sql).map((st) => st.sql);
    if (!statements.length) {
      return;
    }
    try {
      if (!this.session) {
        const conn = await this.conns.dedicated(this.connId, this.db);
        conn.on('error', () => (this.session = undefined));
        conn.on('end', () => (this.session = undefined));
        this.session = conn;
      }
      const maxRows = vscode.workspace.getConfiguration('mysqlLens').get<number>('maxRows', 5000);
      const started = Date.now();
      let shown: ResultSet | undefined;
      const messages: string[] = [];
      let changed = false;
      for (const st of statements) {
        const results = await executeStatement(this.session, st, maxRows);
        for (const r of results) {
          if (r.kind === 'error') {
            throw new Error(statements.length > 1 ? `${r.error}\n\nin: ${st.slice(0, 300)}` : r.error);
          }
          if (r.kind === 'rows') {
            shown = r;
          } else {
            changed = true;
            messages.push(`${(r.affectedRows ?? 0).toLocaleString()} row(s) affected${r.info ? ' · ' + r.info.trim() : ''}`);
          }
        }
      }
      if (shown) {
        this.customSql = sql;
        this.post({
          type: 'page',
          page: {
            columns: shown.columns,
            rows: shown.rows,
            total: shown.totalRows,
            page: 0,
            pageSize: Math.max(1, shown.rows.length),
            sort: null,
            filter: '',
            durationMs: Date.now() - started,
            keyColumns: [],
            readOnlyReason: shown.truncated
              ? `Custom query: showing first ${shown.rows.length.toLocaleString()} of ${shown.totalRows.toLocaleString()} rows (read-only).`
              : 'Custom query results are read-only. Use SELECT * FROM the table to edit rows.',
            query: sql,
            custom: true,
          },
        });
      }
      if (messages.length) {
        this.post({ type: 'queryDone', message: messages.join('\n') });
      }
      if (changed) {
        this.schema.invalidate(this.connId, this.db);
        if (!shown) {
          await this.load();
        }
      }
    } catch (e) {
      this.post({ type: 'pageError', message: errorText(e) });
    }
  }

  async load(): Promise<void> {
    try {
      this.schema.invalidate(this.connId, this.db);
      const meta = await this.schema.gridColumns(this.connId, this.db, this.table);
      this.columns = meta.columns;
      this.keyColumns = this.isView ? [] : meta.keyColumns;
      const { page, pageSize, sort, filter } = this.state;
      const where = filter.trim() ? ` WHERE ${filter}` : '';
      const order = sort ? ` ORDER BY ${qid(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
      const from = qualified(this.db, this.table);
      const started = Date.now();
      const pool = await this.conns.pool(this.connId);
      const [rows, count] = await Promise.all([
        new Promise<unknown[][]>((resolve, reject) =>
          pool.query({ sql: `SELECT * FROM ${from}${where}${order} LIMIT ${pageSize * page}, ${pageSize}`, rowsAsArray: true }, (err, r) =>
            err ? reject(err) : resolve(r as unknown as unknown[][]),
          ),
        ),
        runQuery<{ n: number }[]>(pool, `SELECT COUNT(*) AS n FROM ${from}${where}`),
      ]);
      const cfg = this.conns.config(this.connId);
      const result: TablePage = {
        columns: this.columns,
        rows: rows.map((r) => r.map(toCell)),
        total: Number(count[0]?.n ?? 0),
        page,
        pageSize,
        sort,
        filter,
        durationMs: Date.now() - started,
        keyColumns: cfg.readOnly ? [] : this.keyColumns,
        readOnlyReason: cfg.readOnly
          ? 'Connection is read-only.'
          : this.isView
            ? 'Views are read-only.'
            : this.keyColumns.length
              ? undefined
              : 'Table has no primary or unique key, so rows cannot be identified for editing.',
        query: buildTableQuery(this.table, this.state),
        custom: false,
      };
      this.customSql = null;
      this.post({ type: 'page', page: result });
      this.panel.title = this.table;
    } catch (e) {
      this.post({ type: 'pageError', message: errorText(e) });
    }
  }

  protected async handle(m: GridToExtension): Promise<void> {
    switch (m.type) {
      case 'loadPage':
        this.state = { page: m.page, pageSize: m.pageSize, sort: m.sort, filter: m.filter };
        await this.load();
        return;
      case 'runQuery':
        await this.runQuery(m.sql);
        return;
      case 'rerun':
        if (this.customSql) {
          await this.runQuery(this.customSql);
        } else {
          await this.load();
        }
        return;
      case 'previewChanges':
        this.post({ type: 'preview', statements: m.changes.map((c) => this.changeSql(c)), requestId: m.requestId });
        return;
      case 'applyChanges':
        await this.apply(m.changes);
        return;
      case 'export':
        await this.exportTable(m.format);
        return;
    }
  }

  private col(name: string): ColumnInfo | undefined {
    return this.columns.find((c) => c.name === name);
  }

  private where(key: Record<string, Cell>): string {
    return Object.entries(key)
      .map(([k, v]) => `${qid(k)} ${v === null ? 'IS NULL' : '= ' + cellLiteral(v, this.col(k))}`)
      .join(' AND ');
  }

  private changeSql(c: RowChange): string {
    const t = qualified(this.db, this.table);
    switch (c.kind) {
      case 'update': {
        const set = Object.entries(c.values).map(([k, v]) => `${qid(k)} = ${cellLiteral(v, this.col(k))}`).join(', ');
        return `UPDATE ${t} SET ${set} WHERE ${this.where(c.key)} LIMIT 1;`;
      }
      case 'insert': {
        const entries = Object.entries(c.values);
        if (!entries.length) {
          return `INSERT INTO ${t} () VALUES ();`;
        }
        return `INSERT INTO ${t} (${entries.map(([k]) => qid(k)).join(', ')}) VALUES (${entries.map(([k, v]) => cellLiteral(v, this.col(k))).join(', ')});`;
      }
      case 'delete':
        return `DELETE FROM ${t} WHERE ${this.where(c.key)} LIMIT 1;`;
    }
  }

  private async apply(changes: RowChange[]): Promise<void> {
    const statements = changes.map((c) => this.changeSql(c));
    const pool = await this.conns.pool(this.connId);
    const conn = await new Promise<mysql.PoolConnection>((resolve, reject) => pool.getConnection((e, c) => (e ? reject(e) : resolve(c))));
    let i = 0;
    try {
      await runQuery(conn, 'START TRANSACTION');
      for (; i < statements.length; i++) {
        const r = await runQuery<mysql.ResultSetHeader>(conn, statements[i]);
        if (changes[i].kind !== 'insert' && r.affectedRows === 0) {
          throw new Error('Row was not found. It may have been changed or deleted by someone else. Reload and try again.');
        }
      }
      await runQuery(conn, 'COMMIT');
      this.post({ type: 'applied', ok: true, message: `${statements.length} change${statements.length === 1 ? '' : 's'} saved` });
      this.schema.invalidate(this.connId, this.db);
      await this.load();
    } catch (e) {
      await runQuery(conn, 'ROLLBACK').catch(() => undefined);
      this.post({ type: 'applied', ok: false, message: errorText(e), failedIndex: i });
    } finally {
      conn.release();
    }
  }

  private async exportTable(format: ExportFormat): Promise<void> {
    const file = await pickSaveFile(format, this.table);
    if (!file) {
      return;
    }
    if (this.customSql) {
      const statements = splitSql(this.customSql);
      await exportQuery(this.conns, this.connId, this.db, statements[statements.length - 1].sql, format, file, this.table);
      return;
    }
    const { sort, filter } = this.state;
    const where = filter.trim() ? ` WHERE ${filter}` : '';
    const order = sort ? ` ORDER BY ${qid(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
    await exportQuery(this.conns, this.connId, this.db, `SELECT * FROM ${qualified(this.db, this.table)}${where}${order}`, format, file, this.table);
  }

  protected onDispose(): void {
    tablePanels.delete(this.key);
    this.session?.destroy();
  }
}

/** Streams a query straight into an export file. */
export async function exportQuery(
  conns: ConnectionManager,
  connId: string,
  db: string,
  sql: string,
  format: ExportFormat,
  file: vscode.Uri,
  tableName: string,
  total?: number,
): Promise<void> {
  const conn = await conns.dedicated(connId, db);
  try {
    const s = streamQuery(conn, sql);
    await writeExport({ format, file, tableName, columns: () => s.columns, rows: mapRows(s.rows), total, onCancel: () => conn.destroy() });
  } finally {
    conn.destroy();
  }
}

async function* mapRows(rows: AsyncIterable<unknown[]>): AsyncIterable<Cell[]> {
  for await (const r of rows) {
    yield r.map(exportCell);
  }
}

function firstLine(sql: string): string {
  const line = sql.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? line.slice(0, 117) + '…' : line;
}
