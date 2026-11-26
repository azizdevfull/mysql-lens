export type Cell = string | number | null;

export interface Column {
  name: string;
  type: string;
  pk?: boolean;
  nullable?: boolean;
  autoIncrement?: boolean;
  numeric?: boolean;
  defaultValue?: string | null;
  options?: string[];
  comment?: string;
  /** Binary column (BLOB, BINARY, BIT): values arrive as `0x…` hex. */
  binary?: boolean;
}

export interface Connection {
  id: string;
  name: string;
  color: string;
  host: string;
  port: number;
  user: string;
  database?: string;
  readOnly?: boolean;
  ssh?: { host: string; port: number; user: string; auth: 'password' | 'key' | 'agent'; keyPath?: string };
  ssl?: boolean;
}

export interface TableMeta {
  name: string;
  kind: 'table' | 'view';
  rows: number;
  bytes: number;
}

export interface DbObjects {
  tables: TableMeta[];
  routines: { name: string; kind: 'procedure' | 'function' }[];
  triggers: string[];
}

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
}

export interface PageRequest {
  page: number;
  pageSize: number;
  sort: SortSpec | null;
  filter: string;
}

export interface TablePage {
  columns: Column[];
  rows: Cell[][];
  total: number;
  keyColumns: string[];
  ms: number;
}

export interface ResultSet {
  kind: 'rows' | 'ok' | 'error';
  sql: string;
  columns: Column[];
  rows: Cell[][];
  totalRows: number;
  affectedRows?: number;
  error?: string;
  ms: number;
}

/** `columns` of `db.table` point at `refColumns` of `refDb.refTable`. */
export interface ForeignKey {
  name: string;
  db: string;
  table: string;
  columns: string[];
  refDb: string;
  refTable: string;
  refColumns: string[];
}

/** Foreign keys a table declares (outgoing) and the ones pointing at it (incoming). */
export interface Relations {
  outgoing: ForeignKey[];
  incoming: ForeignKey[];
}

export interface CountRequest {
  db: string;
  table: string;
  /** A SQL condition, as in the table filter. */
  filter: string;
}

/** Identifies one stored cell, so its full value can be read again. */
export interface CellRef {
  connId: string;
  db: string;
  table: string;
  column: string;
  columns: Column[];
  key: Record<string, Cell>;
}

export type RowChange =
  | { kind: 'update'; key: Record<string, Cell>; values: Record<string, Cell> }
  | { kind: 'insert'; values: Record<string, Cell> }
  | { kind: 'delete'; key: Record<string, Cell> };

/** Everything the UI needs from the backend. The Tauri app implements this with Rust commands. */
export interface Secrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown' | 'xlsx';

export interface Backend {
  /** True in the desktop app, false in the browser demo. */
  readonly native: boolean;
  listConnections(): Promise<Connection[]>;
  saveConnection(c: Connection, secrets?: Secrets): Promise<Connection>;
  deleteConnection(id: string): Promise<void>;
  testConnection(c: Connection, password?: string): Promise<string>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  databases(id: string): Promise<string[]>;
  objects(id: string, db: string): Promise<DbObjects>;
  columns(id: string, db: string, table: string): Promise<Column[]>;
  schema(id: string, db: string): Promise<Record<string, Column[]>>;
  tablePage(id: string, db: string, table: string, req: PageRequest): Promise<TablePage>;
  foreignKeys(id: string, db: string, table: string): Promise<Relations>;
  /** Rows matching each request, counted up to `cap`; null where the count failed. */
  countRows(id: string, items: CountRequest[], cap: number): Promise<(number | null)[]>;
  /** The full bytes of one cell as base64. */
  cellBytes(ref: CellRef): Promise<string>;
  /** Asks where to save and writes one cell's bytes there. Null if cancelled. */
  saveCell(ref: CellRef, suggestedName: string): Promise<{ bytes: number; path: string } | null>;
  /** Asks for a file and returns its contents as a `0x…` hex literal. Null if cancelled. */
  loadFileHex(): Promise<string | null>;
  /**
   * Runs SQL. A string is split into statements by the backend; an array is run
   * statement by statement as given. With `runId`, `cancelQuery(runId)` stops it.
   */
  query(id: string, db: string | undefined, sql: string | string[], runId?: string, tx?: string): Promise<ResultSet[]>;
  /** Commits (or rolls back) the manual-commit transaction `tx` started by `query(..., tx)`. */
  txEnd(id: string, tx: string, commit: boolean): Promise<void>;
  /** Closes the manual-commit connection of `tx`, rolling back what was not committed. */
  txClose(tx: string): Promise<void>;
  /** Every foreign key declared in `db` (for the ER diagram). */
  dbForeignKeys(id: string, db: string): Promise<ForeignKey[]>;
  snippetsList(): Promise<Snippet[]>;
  /** Adds a snippet (empty id) or replaces the one with its id. */
  snippetsSave(s: Snippet): Promise<Snippet>;
  snippetsDelete(id: string): Promise<void>;
  /** Kills the statement running for `runId` and skips the rest. False if it already finished. */
  cancelQuery(runId: string): Promise<boolean>;
  previewChanges(id: string, db: string, table: string, columns: Column[], changes: RowChange[]): Promise<string[]>;
  applyChanges(id: string, db: string, table: string, columns: Column[], changes: RowChange[]): Promise<void>;
  /** Asks where to save and exports a table (sql empty) or a query. Returns rows written, or null if cancelled. */
  exportData(id: string, db: string, table: string, sql: string, format: ExportFormat): Promise<{ rows: number; path: string } | null>;
  revealFile(path: string): Promise<void>;
  /** Asks for a file and writes a SQL dump. Progress goes to `onProgress`. */
  dumpDatabase(id: string, opts: DumpOptions, onProgress: (msg: string) => void): Promise<{ tables: number; rows: number; path: string } | null>;
  /** Asks for a .sql/.sql.gz file and runs it. */
  importSql(id: string, db: string | undefined, continueOnError: boolean, onProgress: (msg: string) => void): Promise<{ statements: number; errors: string[]; file: string } | null>;
  pickDataFile(): Promise<string | null>;
  importPreview(path: string, opts?: SourceOptions): Promise<ImportPreview>;
  importData(id: string, db: string, path: string, opts: SourceOptions, plan: ImportPlan, onProgress: (rows: number) => void): Promise<number>;
  /** The saved session (open tabs) as JSON text, or null if none was saved. */
  loadSession(): Promise<string | null>;
  saveSession(json: string): Promise<void>;
  /** Executed queries, newest first. */
  historyList(): Promise<HistoryEntry[]>;
  historyDelete(id: string): Promise<void>;
  historyClear(): Promise<void>;
  /** Asks where to save and writes every connection without passwords. Null if cancelled. */
  exportConnections(): Promise<{ count: number; path: string } | null>;
  /** Asks for an export file and adds its connections. Null if cancelled. */
  importConnections(): Promise<{ added: number; skipped: number } | null>;
}

/** A saved query. */
export interface Snippet {
  id: string;
  name: string;
  sql: string;
  connId?: string;
  db?: string;
  /** Unix time in milliseconds. */
  created: number;
  updated: number;
}

export interface HistoryEntry {
  id: string;
  /** Unix time in milliseconds. */
  ts: number;
  connId: string;
  connName: string;
  db?: string;
  sql: string;
  ms: number;
  rows: number;
  affected: number;
  error?: string;
}

export interface SourceOptions {
  delimiter: string;
  header: boolean;
  sheet?: string | null;
  encoding: string;
}

export interface ImportPreview {
  fileName: string;
  fileKind: 'csv' | 'json' | 'excel';
  sourceColumns: string[];
  rows: Cell[][];
  rowCount: number | null;
  sheets: string[];
  options: SourceOptions;
  inferredTypes: string[];
}

export interface ImportPlan {
  createTable: boolean;
  table: string;
  newColumns: { name: string; type: string; source: number }[];
  mapping: { column: string; source: number }[];
  mode: 'insert' | 'ignore' | 'replace';
  truncateFirst: boolean;
  emptyAsNull: boolean;
  batchSize: number;
}

export interface DumpOptions {
  database: string;
  tables: string[];
  structure: boolean;
  data: boolean;
  dropObjects: boolean;
  createDatabase: boolean;
  views: boolean;
  routines: boolean;
  triggers: boolean;
  gzip: boolean;
}
