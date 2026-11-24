/**
 * Types shared between the extension host and the webviews.
 * This file must not import anything from `vscode` or Node.
 */

export type Cell = string | number | null;

export interface ColumnInfo {
  name: string;
  /** Display type, e.g. `varchar(255)` or `INT`. */
  type: string;
  table?: string;
  pk?: boolean;
  nullable?: boolean;
  autoIncrement?: boolean;
  numeric?: boolean;
  binary?: boolean;
  /** Column default as stored in information_schema (table mode only). */
  defaultValue?: string | null;
  comment?: string;
  /** Allowed values for ENUM / SET columns (table mode only). */
  options?: string[];
}

export interface ResultSet {
  id: number;
  sql: string;
  kind: 'rows' | 'ok' | 'error';
  columns: ColumnInfo[];
  rows: Cell[][];
  /** Rows the server returned, including the ones dropped because of the row limit. */
  totalRows: number;
  truncated: boolean;
  affectedRows?: number;
  insertId?: number;
  info?: string;
  warnings?: number;
  error?: string;
  durationMs: number;
}

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
}

export type RowChange =
  | { kind: 'update'; key: Record<string, Cell>; values: Record<string, Cell> }
  | { kind: 'insert'; values: Record<string, Cell> }
  | { kind: 'delete'; key: Record<string, Cell> };

export interface TablePage {
  columns: ColumnInfo[];
  rows: Cell[][];
  total: number;
  page: number;
  pageSize: number;
  sort: SortSpec | null;
  filter: string;
  durationMs: number;
  /** Columns that identify a row. Empty means the table cannot be edited. */
  keyColumns: string[];
  readOnlyReason?: string;
  /** SQL that produced this page, shown in the query editor. */
  query: string;
  /** True when the page comes from a free-form query instead of table paging. */
  custom: boolean;
}

export interface SchemaColumn {
  name: string;
  type: string;
  pk?: boolean;
}

/** Table and column names for autocomplete in the query editor. */
export interface SchemaInfo {
  database: string;
  table: string;
  tables: string[];
  columns: Record<string, SchemaColumn[]>;
}

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown' | 'xlsx';

/* ---------------- Grid panel (query results + table editor) ---------------- */

export type GridToWebview =
  | { type: 'init'; mode: 'results' | 'table'; title: string; subtitle: string; readOnly: boolean }
  | { type: 'running'; label: string; statementCount: number }
  | { type: 'result'; result: ResultSet }
  | { type: 'done'; cancelled: boolean; durationMs: number }
  | { type: 'page'; page: TablePage }
  | { type: 'pageError'; message: string }
  | { type: 'preview'; statements: string[]; requestId: number }
  | { type: 'applied'; ok: boolean; message?: string; failedIndex?: number }
  | { type: 'schema'; schema: SchemaInfo }
  | { type: 'queryDone'; message: string };

export type GridToExtension =
  | { type: 'ready' }
  | { type: 'cancel' }
  | { type: 'rerun' }
  | { type: 'export'; resultId?: number; format: ExportFormat }
  | { type: 'loadPage'; page: number; pageSize: number; sort: SortSpec | null; filter: string }
  | { type: 'runQuery'; sql: string }
  | { type: 'previewChanges'; changes: RowChange[]; requestId: number }
  | { type: 'applyChanges'; changes: RowChange[] }
  | { type: 'copy'; text: string }
  | { type: 'openText'; text: string; language: string }
  | { type: 'notify'; level: 'info' | 'warn' | 'error'; message: string };

/* ---------------- Connection form ---------------- */

export interface ConnectionFormData {
  id?: string;
  name: string;
  color: string;
  host: string;
  port: number;
  user: string;
  password: string;
  savePassword: boolean;
  database: string;
  readOnly: boolean;
  connectTimeout: number;
  ssl: {
    enabled: boolean;
    rejectUnauthorized: boolean;
    ca: string;
    cert: string;
    key: string;
  };
  ssh: {
    enabled: boolean;
    host: string;
    port: number;
    user: string;
    auth: 'password' | 'privateKey' | 'agent';
    password: string;
    privateKeyPath: string;
    passphrase: string;
  };
}

export type FormToWebview =
  | { type: 'load'; data: ConnectionFormData; isNew: boolean }
  | { type: 'testResult'; ok: boolean; message: string }
  | { type: 'pickedFile'; field: string; path: string }
  | { type: 'saveError'; message: string };

export type FormToExtension =
  | { type: 'ready' }
  | { type: 'test'; data: ConnectionFormData }
  | { type: 'save'; data: ConnectionFormData; connect: boolean }
  | { type: 'cancel' }
  | { type: 'pickFile'; field: string };

/* ---------------- Data import wizard ---------------- */

export interface ImportSourceOptions {
  delimiter: string;
  header: boolean;
  quote: string;
  encoding: string;
  sheet?: string;
}

export interface ImportPreview {
  fileName: string;
  fileKind: 'csv' | 'json' | 'xlsx';
  sourceColumns: string[];
  rows: Cell[][];
  /** Rows counted while parsing; for CSV this may be the preview size only. */
  rowCountHint: string;
  sheets?: string[];
  options: ImportSourceOptions;
  /** Suggested SQL types for each source column, used when creating a new table. */
  inferredTypes: string[];
}

export interface ImportTarget {
  database: string;
  tables: string[];
}

export interface ImportPlan {
  createTable: boolean;
  table: string;
  /** For a new table: column definitions. */
  newColumns: { name: string; type: string; source: number }[];
  /** For an existing table: target column -> source column index, -1 = skip. */
  mapping: { column: string; source: number }[];
  mode: 'insert' | 'ignore' | 'replace';
  truncateFirst: boolean;
  emptyAsNull: boolean;
  batchSize: number;
}

export type ImportToWebview =
  | { type: 'init'; target: ImportTarget; preselectTable?: string }
  | { type: 'preview'; preview: ImportPreview }
  | { type: 'previewError'; message: string }
  | { type: 'tableColumns'; table: string; columns: ColumnInfo[] }
  | { type: 'progress'; done: number; total: number | null; message: string }
  | { type: 'finished'; ok: boolean; message: string };

export type ImportToExtension =
  | { type: 'ready' }
  | { type: 'pickFile' }
  | { type: 'reparse'; options: ImportSourceOptions }
  | { type: 'loadTable'; table: string }
  | { type: 'run'; plan: ImportPlan }
  | { type: 'cancel' }
  | { type: 'close' }
  | { type: 'openTable'; table: string };
