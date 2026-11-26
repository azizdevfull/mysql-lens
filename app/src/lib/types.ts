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
  query(id: string, db: string | undefined, sql: string): Promise<ResultSet[]>;
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
  /** Executed queries, newest first. */
  historyList(): Promise<HistoryEntry[]>;
  historyDelete(id: string): Promise<void>;
  historyClear(): Promise<void>;
  /** Asks where to save and writes every connection without passwords. Null if cancelled. */
  exportConnections(): Promise<{ count: number; path: string } | null>;
  /** Asks for an export file and adds its connections. Null if cancelled. */
  importConnections(): Promise<{ added: number; skipped: number } | null>;
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
