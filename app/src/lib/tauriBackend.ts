import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { Backend, ExportFormat } from './types';

const EXT: Record<ExportFormat, [string, string]> = {
  csv: ['CSV', 'csv'],
  tsv: ['TSV', 'tsv'],
  json: ['JSON', 'json'],
  sql: ['SQL', 'sql'],
  markdown: ['Markdown', 'md'],
  xlsx: ['Excel', 'xlsx'],
};

/** Backend implemented by the Rust side of the desktop app. */
export const tauriBackend: Backend = {
  native: true,
  listConnections: () => invoke('list_connections'),
  saveConnection: (c, secrets) => invoke('save_connection', { c, password: secrets?.password ?? null, sshPassword: secrets?.sshPassword ?? null, sshPassphrase: secrets?.sshPassphrase ?? null }),
  deleteConnection: (id) => invoke('delete_connection', { id }),
  testConnection: (c, password) => invoke('test_connection', { c, password: password || null }),
  connect: (id) => invoke('connect', { id }),
  disconnect: (id) => invoke('disconnect', { id }),
  databases: (id) => invoke('databases', { id }),
  objects: (id, db) => invoke('objects', { id, db }),
  columns: (id, db, table) => invoke('columns', { id, db, table }),
  schema: (id, db) => invoke('schema', { id, db }),
  tablePage: (id, db, table, req) => invoke('table_page', { id, db, table, req }),
  foreignKeys: (id, db, table) => invoke('foreign_keys', { id, db, table }),
  countRows: (id, items, cap) => invoke('count_rows', { id, items, cap }),
  cellBytes: (r) => invoke('cell_bytes', { id: r.connId, db: r.db, table: r.table, column: r.column, columns: r.columns, key: r.key }),
  async saveCell(r, suggestedName) {
    const path = await save({ defaultPath: suggestedName });
    if (!path) return null;
    const bytes = await invoke<number>('save_cell', { id: r.connId, db: r.db, table: r.table, column: r.column, columns: r.columns, key: r.key, path });
    return { bytes, path };
  },
  async loadFileHex() {
    const path = await open({ multiple: false });
    if (!path || Array.isArray(path)) return null;
    return invoke<string>('file_hex', { path });
  },
  query: (id, db, sql, runId, tx) =>
    Array.isArray(sql)
      ? invoke('query', { id, db: db ?? null, sql: '', statements: sql, runId: runId ?? null, tx: tx ?? null })
      : invoke('query', { id, db: db ?? null, sql, runId: runId ?? null, tx: tx ?? null }),
  txEnd: (id, tx, commit) => invoke('tx_end', { id, tx, commit }),
  txClose: (tx) => invoke('tx_close', { tx }),
  dbForeignKeys: (id, db) => invoke('db_foreign_keys', { id, db }),
  snippetsList: () => invoke('snippets_list'),
  snippetsSave: (snippet) => invoke('snippets_save', { snippet }),
  snippetsDelete: (id) => invoke('snippets_delete', { id }),
  cancelQuery: (runId) => invoke('cancel_query', { runId }),
  previewChanges: (_id, db, table, columns, changes) => invoke('preview_changes', { db, table, columns, changes }),
  applyChanges: (id, db, table, columns, changes) => invoke('apply_changes', { id, db, table, columns, changes }),
  async exportData(id, db, table, sql, format) {
    const [name, ext] = EXT[format];
    const path = await save({ defaultPath: `${table}.${ext}`, filters: [{ name, extensions: [ext] }] });
    if (!path) return null;
    const rows = await invoke<number>('export_data', { id, db, table, sql, format, path });
    return { rows, path };
  },
  revealFile: (path) => revealItemInDir(path),
  async dumpDatabase(id, o, onProgress) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');
    const path = await save({ defaultPath: `${o.database}_${stamp}.sql${o.gzip ? '.gz' : ''}`, filters: o.gzip ? [{ name: 'Gzipped SQL', extensions: ['gz'] }] : [{ name: 'SQL dump', extensions: ['sql'] }] });
    if (!path) return null;
    const off = await listen<{ table: string; index: number; count: number; rows: number }>('dump-progress', (e) =>
      onProgress(`${e.payload.table} (${e.payload.index + 1}/${e.payload.count})${e.payload.rows ? ` · ${e.payload.rows.toLocaleString()} rows` : ''}`),
    );
    try {
      const { gzip: _gzip, ...opts } = o;
      const r = await invoke<{ tables: number; rows: number }>('dump_database', { id, opts, path });
      return { ...r, path };
    } finally {
      off();
    }
  },
  async pickDataFile() {
    const f = await open({ multiple: false, filters: [{ name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson', 'xlsx', 'xlsm', 'xls', 'ods'] }] });
    return f && !Array.isArray(f) ? String(f) : null;
  },
  importPreview: (path, opts) => invoke('import_preview', { path, opts: opts ?? null }),
  async importData(id, db, path, opts, plan, onProgress) {
    const off = await listen<number>('data-import-progress', (e) => onProgress(e.payload));
    try {
      return await invoke<number>('import_data', { id, db, path, opts, plan });
    } finally {
      off();
    }
  },
  loadSession: () => invoke('session_load'),
  saveSession: (data) => invoke('session_save', { data }),
  historyList: () => invoke('history_list'),
  historyDelete: (id) => invoke('history_delete', { id }),
  historyClear: () => invoke('history_clear'),
  async exportConnections() {
    const path = await save({ defaultPath: 'mysql-connections.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!path) return null;
    const count = await invoke<number>('export_connections', { path });
    return { count, path };
  },
  async importConnections() {
    const path = await open({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!path || Array.isArray(path)) return null;
    return invoke<{ added: number; skipped: number }>('import_connections', { path });
  },
  async importSql(id, db, continueOnError, onProgress) {
    const file = await open({ multiple: false, filters: [{ name: 'SQL files', extensions: ['sql', 'gz'] }] });
    if (!file || Array.isArray(file)) return null;
    const off = await listen<{ read: number; total: number; statements: number }>('import-progress', (e) =>
      onProgress(`${Math.round((e.payload.read / Math.max(1, e.payload.total)) * 100)}% · ${e.payload.statements.toLocaleString()} statements`),
    );
    try {
      const r = await invoke<{ statements: number; errors: string[] }>('import_sql', { id, db: db ?? null, path: file, continueOnError });
      return { ...r, file: String(file).split(/[\\/]/).pop() ?? String(file) };
    } finally {
      off();
    }
  },
};
