import type { Backend, McpActivity, McpApproval } from './types';
import { dumpFileName, EXPORT_EXT } from './files';

/*
 * Backend for a browser using the desktop app's web access. Commands go to
 * `/api/call/<command>` with the same arguments as the desktop `invoke` calls.
 * Files are uploaded and downloaded instead of being picked by path.
 */

interface CallResult<T> {
  result: T;
  download: string | null;
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<CallResult<T>> {
  const r = await fetch(`/api/call/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lens': '1' }, body: JSON.stringify(args) });
  if (r.status === 401) {
    location.assign('/login');
    throw 'Signed out. Sign in again.';
  }
  const body = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  // Rejected with a string, like the desktop app's invoke.
  if (!r.ok) throw String(body.error ?? r.statusText);
  return body as CallResult<T>;
}

const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => (await call<T>(cmd, args)).result;

/** Opens the browser's file picker; null if nothing was chosen. */
function pickFile(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Sends a file to the app; returns the reference commands take as `path`. */
async function upload(file: File): Promise<{ upload: string }> {
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-lens': '1', 'content-type': 'application/octet-stream' }, body: file });
  const body = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw String(body.error ?? r.statusText);
  return { upload: body.id as string };
}

/** Runs a command that writes a file, then lets the browser save it as `name`. */
async function withDownload<T>(cmd: string, args: Record<string, unknown>, name: string): Promise<T> {
  const r = await call<T>(cmd, { ...args, path: { download: name } });
  if (r.download) {
    const a = document.createElement('a');
    a.href = r.download;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return r.result;
}

/* App events arrive over one server-sent event stream. */
const handlers = new Map<string, Set<(payload: unknown) => void>>();
let events: EventSource | null = null;

function listen<T>(event: string, cb: (payload: T) => void): () => void {
  if (!events) {
    events = new EventSource('/api/events');
    events.onmessage = (m) => {
      try {
        const { event: name, payload } = JSON.parse(m.data) as { event: string; payload: unknown };
        handlers.get(name)?.forEach((h) => h(payload));
      } catch {
        // not an event of ours
      }
    };
  }
  const h = cb as (payload: unknown) => void;
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(h);
  return () => void handlers.get(event)?.delete(h);
}

/** Data files are uploaded when picked; this prefix marks such a "path". */
const UPLOADED = 'upload:';
const pathRef = (path: string) => (path.startsWith(UPLOADED) ? { upload: path.slice(UPLOADED.length) } : path);

const SESSION_KEY = 'web-session';

export const httpBackend: Backend = {
  native: false,
  web: true,
  listConnections: () => invoke('list_connections'),
  saveConnection: (c, secrets) => invoke('save_connection', { c, password: secrets?.password ?? null, sshPassword: secrets?.sshPassword ?? null, sshPassphrase: secrets?.sshPassphrase ?? null }),
  deleteConnection: (id) => invoke('delete_connection', { id }),
  moveConnections: (ids, folder) => invoke('move_connections', { ids, folder }),
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
    const bytes = await withDownload<number>('save_cell', { id: r.connId, db: r.db, table: r.table, column: r.column, columns: r.columns, key: r.key }, suggestedName);
    return { bytes, path: suggestedName };
  },
  async loadFileHex() {
    const file = await pickFile();
    if (!file) return null;
    return invoke<string>('file_hex', { path: await upload(file) });
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
  mcpStatus: () => invoke('mcp_status'),
  mcpSave: () => Promise.reject('AI access is set up in the desktop app.'),
  mcpApprove: (id, allow) => invoke('mcp_approve', { id, allow }),
  async onMcpApproval(cb, expired) {
    const a = listen<McpApproval>('mcp-approval', cb);
    const b = listen<string>('mcp-approval-expired', expired);
    return () => {
      a();
      b();
    };
  },
  async onMcpActivity(cb) {
    return listen<McpActivity>('mcp-activity', cb);
  },
  webStatus: async () => null,
  webSave: () => Promise.reject('Web access is set up in the desktop app.'),
  cancelQuery: (runId) => invoke('cancel_query', { runId }),
  previewChanges: (_id, db, table, columns, changes) => invoke('preview_changes', { db, table, columns, changes }),
  applyChanges: (id, db, table, columns, changes) => invoke('apply_changes', { id, db, table, columns, changes }),
  async exportData(id, db, table, sql, format) {
    const name = `${table}.${EXPORT_EXT[format][1]}`;
    const rows = await withDownload<number>('export_data', { id, db, table, sql, format }, name);
    return { rows, path: name };
  },
  revealFile: async () => {},
  async dumpDatabase(id, o, onProgress) {
    const name = dumpFileName(o);
    const off = listen<{ table: string; index: number; count: number; rows: number }>('dump-progress', (p) =>
      onProgress(`${p.table} (${p.index + 1}/${p.count})${p.rows ? ` · ${p.rows.toLocaleString()} rows` : ''}`),
    );
    try {
      const { gzip: _gzip, ...opts } = o;
      const r = await withDownload<{ tables: number; rows: number }>('dump_database', { id, opts }, name);
      return { ...r, path: name };
    } finally {
      off();
    }
  },
  async pickDataFile() {
    const file = await pickFile('.csv,.tsv,.txt,.json,.jsonl,.ndjson,.xlsx,.xlsm,.xls,.ods');
    if (!file) return null;
    return UPLOADED + (await upload(file)).upload;
  },
  importPreview: (path, opts) => invoke('import_preview', { path: pathRef(path), opts: opts ?? null }),
  async importData(id, db, path, opts, plan, onProgress) {
    const off = listen<number>('data-import-progress', onProgress);
    try {
      return await invoke<number>('import_data', { id, db, path: pathRef(path), opts, plan });
    } finally {
      off();
    }
  },
  // Each browser keeps its own open tabs.
  async loadSession() {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  },
  async saveSession(json) {
    try {
      localStorage.setItem(SESSION_KEY, json);
    } catch {
      // the next visit starts fresh
    }
  },
  historyList: () => invoke('history_list'),
  historyDelete: (id) => invoke('history_delete', { id }),
  historyClear: () => invoke('history_clear'),
  async exportConnections() {
    const name = 'mysql-connections.json';
    const count = await withDownload<number>('export_connections', {}, name);
    return { count, path: name };
  },
  async importConnections() {
    const file = await pickFile('.json');
    if (!file) return null;
    return invoke<{ added: number; skipped: number }>('import_connections', { path: await upload(file) });
  },
  async importSql(id, db, continueOnError, onProgress) {
    const file = await pickFile('.sql,.gz');
    if (!file) return null;
    onProgress('Uploading…');
    const path = await upload(file);
    const off = listen<{ read: number; total: number; statements: number }>('import-progress', (p) =>
      onProgress(`${Math.round((p.read / Math.max(1, p.total)) * 100)}% · ${p.statements.toLocaleString()} statements`),
    );
    try {
      const r = await invoke<{ statements: number; errors: string[] }>('import_sql', { id, db: db ?? null, path, continueOnError });
      return { ...r, file: file.name };
    } finally {
      off();
    }
  },
};
