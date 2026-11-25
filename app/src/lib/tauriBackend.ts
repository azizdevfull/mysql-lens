import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
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
  query: (id, db, sql) => invoke('query', { id, db: db ?? null, sql }),
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
};
