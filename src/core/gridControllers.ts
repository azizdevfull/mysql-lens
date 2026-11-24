import * as mysql from 'mysql2';
import type { ConnectionManager } from '../connections/manager';
import { runQuery } from '../connections/driver';
import type { SchemaService } from '../schema';
import type { Cell, ColumnInfo, ExportFormat, GridToExtension, GridToWebview, ResultSet, RowChange, SortSpec, TablePage } from '../shared/protocol';
import { cellLiteral, qid, qualified, toCell } from '../sql';
import { executeStatement, killQuery } from '../query/executor';
import { splitSql } from '../query/splitter';
import { buildTableQuery, parseTableQuery } from '../query/tableQuery';
import { streamQuery } from '../io/exporters';
import { errorText } from './errors';
import { exportQuery, exportRows, pickSaveFile, writeExport } from './exportRun';
import type { UiHost } from './host';

/** Message plumbing shared by the results view and the table editor. */
export abstract class GridController {
  private readyResolve!: () => void;
  readonly ready = new Promise<void>((r) => (this.readyResolve = r));
  protected disposed = false;

  constructor(
    protected readonly host: UiHost,
    private readonly postFn: (m: GridToWebview) => void,
  ) {}

  protected post(m: GridToWebview): void {
    if (!this.disposed) {
      this.postFn(m);
    }
  }

  /** Feed every message from the view here. */
  async receive(m: GridToExtension): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.readyResolve();
          return;
        case 'copy':
          await this.host.copy(m.text);
          return;
        case 'openText':
          await this.host.openText(m.text, m.language);
          return;
        case 'notify':
          if (m.level === 'error') this.host.error(m.message);
          else if (m.level === 'warn') void this.host.warn(m.message);
          else void this.host.info(m.message);
          return;
        default:
          await this.handle(m);
      }
    } catch (e) {
      this.host.error(errorText(e));
    }
  }

  protected abstract handle(m: GridToExtension): Promise<void>;

  dispose(): void {
    this.disposed = true;
    this.onDispose();
  }

  protected onDispose(): void {}
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

export class ResultsController extends GridController {
  private results: ResultSet[] = [];
  private running = false;
  private cancelled = false;
  private lastRun?: { target: RunTarget; statements: string[] };

  constructor(
    host: UiHost,
    post: (m: GridToWebview) => void,
    private readonly conns: ConnectionManager,
    private readonly onRerun: () => void,
  ) {
    super(host, post);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get rerunInfo(): { target: RunTarget; statements: string[] } | undefined {
    return this.lastRun;
  }

  async run(target: RunTarget, statements: string[], onExecuted: (sql: string, ok: boolean, ms: number) => void): Promise<void> {
    if (this.running) {
      void this.host.warn('A query is already running here. Cancel it first.');
      return;
    }
    await this.ready;
    this.lastRun = { target, statements };
    this.running = true;
    this.cancelled = false;
    this.results = [];
    const maxRows = this.host.settings().maxRows;
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

  async cancel(): Promise<void> {
    if (this.running && this.lastRun) {
      this.cancelled = true;
      const pool = await this.conns.pool(this.lastRun.target.connId);
      await killQuery(pool, this.lastRun.target.conn.threadId ?? 0);
    }
  }

  protected async handle(m: GridToExtension): Promise<void> {
    switch (m.type) {
      case 'cancel':
        await this.cancel();
        return;
      case 'rerun':
        if (this.lastRun) {
          this.onRerun();
        }
        return;
      case 'export':
        await this.exportResult(m.resultId, m.format);
        return;
    }
  }

  private async exportResult(id: number | undefined, format: ExportFormat): Promise<void> {
    const r = this.results.find((x) => x.id === id) ?? this.results.find((x) => x.kind === 'rows');
    if (!r || r.kind !== 'rows' || !this.lastRun) {
      return;
    }
    let full = false;
    if (r.truncated && /^\s*(select|with|show|\(|table|values)/i.test(r.sql)) {
      const choice = await this.host.pick(
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
    const file = await pickSaveFile(this.host, format, table);
    if (!file) {
      return;
    }
    if (!full) {
      await writeExport(this.host, { format, file, tableName: table, columns: async () => r.columns, rows: r.rows, total: r.rows.length });
      return;
    }
    const conn = await this.conns.dedicated(this.lastRun.target.connId, this.lastRun.target.database);
    try {
      const s = streamQuery(conn, r.sql);
      await writeExport(this.host, { format, file, tableName: table, columns: () => s.columns, rows: exportRows(s.rows), total: r.totalRows, onCancel: () => conn.destroy() });
    } finally {
      conn.destroy();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Table data editor                                                    */
/* ------------------------------------------------------------------ */

export class TableController extends GridController {
  private columns: ColumnInfo[] = [];
  private keyColumns: string[] = [];
  private state: { page: number; pageSize: number; sort: SortSpec | null; filter: string };
  /** Free-form query currently shown instead of table paging. */
  private customSql: string | null = null;
  /** Dedicated session for free-form queries (keeps USE / SET between runs). */
  private session?: mysql.Connection;

  constructor(
    host: UiHost,
    post: (m: GridToWebview) => void,
    private readonly conns: ConnectionManager,
    private readonly schema: SchemaService,
    readonly connId: string,
    readonly db: string,
    readonly table: string,
    private readonly isView: boolean,
  ) {
    super(host, post);
    this.state = { page: 0, pageSize: host.settings().pageSize, sort: null, filter: '' };
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

  /** Re-runs whatever is shown (table page or custom query). */
  async reload(): Promise<void> {
    if (this.customSql) {
      await this.runQuery(this.customSql);
    } else {
      await this.load();
    }
  }

  /** Runs SQL typed in the query editor. */
  private async runQuery(sql: string): Promise<void> {
    const simple = parseTableQuery(sql, this.db, this.table, this.host.settings().pageSize);
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
      const maxRows = this.host.settings().maxRows;
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
        await this.reload();
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
    const file = await pickSaveFile(this.host, format, this.table);
    if (!file) {
      return;
    }
    if (this.customSql) {
      const statements = splitSql(this.customSql);
      await exportQuery(this.host, this.conns, this.connId, this.db, statements[statements.length - 1].sql, format, file, this.table);
      return;
    }
    const { sort, filter } = this.state;
    const where = filter.trim() ? ` WHERE ${filter}` : '';
    const order = sort ? ` ORDER BY ${qid(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
    await exportQuery(this.host, this.conns, this.connId, this.db, `SELECT * FROM ${qualified(this.db, this.table)}${where}${order}`, format, file, this.table);
  }

  protected onDispose(): void {
    this.session?.destroy();
  }
}

function firstLine(sql: string): string {
  const line = sql.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? line.slice(0, 117) + '…' : line;
}
