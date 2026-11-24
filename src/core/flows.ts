import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectionManager, SecretKind } from '../connections/manager';
import { ConnectionConfig, defaultConfig } from '../connections/types';
import type { SchemaService } from '../schema';
import { dumpDatabase } from '../io/dump';
import { importSqlFile } from '../io/sqlImport';
import { formatBytes, qid, qualified } from '../sql';
import { errorText } from './errors';
import { exportQuery, pickFormat, pickSaveFile } from './exportRun';
import type { UiHost } from './host';

/** Persistent connection list, implemented by each app. */
export interface ConnectionStoreLike {
  list(): ConnectionConfig[];
  get(id: string): ConnectionConfig | undefined;
  save(config: Omit<ConnectionConfig, 'id'> & { id?: string }): Promise<ConnectionConfig>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  getSecret(id: string, kind: SecretKind): PromiseLike<string | undefined>;
  setSecret(id: string, kind: SecretKind, value: string | undefined): Promise<void>;
}

export interface Ctx {
  host: UiHost;
  conns: ConnectionManager;
  schema: SchemaService;
  store: ConnectionStoreLike;
}

/* ----------------------------- connections ----------------------------- */

export async function deleteConnection(c: Ctx, connId: string): Promise<boolean> {
  const cfg = c.store.get(connId);
  if (!cfg) return false;
  const ok = await c.host.confirm(`Delete connection "${cfg.name}"?`, 'Saved passwords for it are removed too. Databases are not touched.', 'Delete');
  if (ok !== 'Delete') return false;
  await c.conns.disconnect(connId);
  await c.store.remove(connId);
  return true;
}

export async function exportConnections(c: Ctx): Promise<void> {
  const list = c.store.list();
  if (!list.length) {
    void c.host.info('No connections to export.');
    return;
  }
  const picked = await c.host.pickMany(
    list.map((x) => ({ label: x.name, description: `${x.user}@${x.host}:${x.port}`, picked: true, x })),
    { title: 'Export connections (passwords are not exported)' },
  );
  if (!picked?.length) return;
  const file = await c.host.saveFile({ defaultName: 'mysql-connections.json', filters: { JSON: ['json'] } });
  if (!file) return;
  const data = { format: 'mysql-lens-connections', version: 1, connections: picked.map((p) => ({ ...p.x, id: undefined })) };
  await fs.promises.writeFile(file, JSON.stringify(data, null, 2));
  void c.host.info(`Exported ${picked.length} connection(s). Passwords were not included.`);
}

export async function importConnections(c: Ctx): Promise<number> {
  const file = await c.host.openFile({ filters: { JSON: ['json'] } });
  if (!file) return 0;
  const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  const items: Partial<ConnectionConfig>[] = Array.isArray(raw) ? raw : (raw.connections ?? []);
  let n = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object' || !it.host) continue;
    const base = defaultConfig();
    await c.store.save({
      ...base,
      ...it,
      id: randomUUID(),
      name: it.name || `${it.user ?? base.user}@${it.host}`,
      port: Number(it.port) || 3306,
      ssl: { ...base.ssl, ...(it.ssl ?? {}) },
      ssh: { ...base.ssh, ...(it.ssh ?? {}) },
    });
    n++;
  }
  void c.host.info(n ? `Imported ${n} connection(s). Edit each one to enter its password.` : 'No connections found in that file.');
  return n;
}

/* ----------------------------- databases & objects ----------------------------- */

export async function createDatabase(c: Ctx, connId: string): Promise<boolean> {
  const name = await c.host.input({ title: 'Create database', prompt: 'Database name', validate: (v) => (v.trim() ? undefined : 'Required') });
  if (!name?.trim()) return false;
  const collations = ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_bin', 'utf8_general_ci', 'latin1_swedish_ci'];
  const collation = await c.host.pick(collations.map((x) => ({ label: x })), { title: 'Collation' });
  if (!collation) return false;
  const charset = collation.label.split('_')[0];
  await c.conns.query(connId, `CREATE DATABASE ${qid(name.trim())} CHARACTER SET ${charset} COLLATE ${collation.label}`);
  c.schema.invalidate(connId);
  return true;
}

export async function dropDatabase(c: Ctx, connId: string, db: string): Promise<boolean> {
  const typed = await c.host.input({
    title: `Drop database ${db}`,
    prompt: `This permanently deletes every table in "${db}". Type the database name to confirm.`,
    validate: (v) => (v === db ? undefined : 'Name does not match'),
  });
  if (typed !== db) return false;
  await c.conns.query(connId, `DROP DATABASE ${qid(db)}`);
  c.schema.invalidate(connId);
  return true;
}

export async function truncateTable(c: Ctx, connId: string, db: string, table: string): Promise<boolean> {
  const ok = await c.host.confirm(`Delete all rows from ${db}.${table}?`, 'TRUNCATE cannot be undone.', 'Truncate');
  if (ok !== 'Truncate') return false;
  await c.conns.query(connId, `TRUNCATE TABLE ${qualified(db, table)}`);
  c.schema.invalidate(connId, db);
  return true;
}

export async function dropObject(c: Ctx, kind: string, connId: string, db: string, name: string): Promise<boolean> {
  const ok = await c.host.confirm(`Drop ${kind} ${db}.${name}?`, 'This cannot be undone.', 'Drop');
  if (ok !== 'Drop') return false;
  await c.conns.query(connId, `DROP ${kind.toUpperCase()} ${qualified(db, name)}`);
  c.schema.invalidate(connId, db);
  return true;
}

/* ----------------------------- SQL templates ----------------------------- */

function placeholder(dataType: string): string {
  const t = dataType.toLowerCase();
  if (/int|decimal|float|double|bit|year/.test(t)) return '0';
  if (t === 'date') return "'2025-01-01'";
  if (/datetime|timestamp/.test(t)) return 'NOW()';
  if (t === 'json') return "'{}'";
  return "''";
}

export async function sqlTemplate(c: Ctx, kind: 'select' | 'insert' | 'update', connId: string, db: string, table: string): Promise<string> {
  const cols = await c.schema.columns(connId, db, table);
  if (kind === 'select') {
    return `SELECT ${cols.map((x) => qid(x.name)).join(',\n       ')}\n  FROM ${qid(table)}\n WHERE 1 = 1\n LIMIT 100;\n`;
  }
  if (kind === 'insert') {
    const ins = cols.filter((x) => !/auto_increment|GENERATED/i.test(x.extra));
    return `INSERT INTO ${qid(table)}\n  (${ins.map((x) => qid(x.name)).join(', ')})\nVALUES\n  (${ins.map((x) => placeholder(x.dataType)).join(', ')});\n`;
  }
  const pk = cols.filter((x) => x.key === 'PRI');
  const set = cols.filter((x) => x.key !== 'PRI' && !/GENERATED/i.test(x.extra));
  const where = (pk.length ? pk : cols.slice(0, 1)).map((x) => `${qid(x.name)} = ${placeholder(x.dataType)}`).join(' AND ');
  return `UPDATE ${qid(table)}\n   SET ${set.map((x) => `${qid(x.name)} = ${placeholder(x.dataType)}`).join(',\n       ')}\n WHERE ${where};\n`;
}

/* ----------------------------- export / import ----------------------------- */

export async function exportTable(c: Ctx, connId: string, db: string, table: string): Promise<void> {
  const format = await pickFormat(c.host);
  if (!format) return;
  const file = await pickSaveFile(c.host, format, table);
  if (!file) return;
  const meta = (await c.schema.tables(connId, db)).find((t) => t.name === table);
  await exportQuery(c.host, c.conns, connId, db, `SELECT * FROM ${qualified(db, table)}`, format, file, table, meta?.rows ?? undefined);
}

export async function exportDatabase(c: Ctx, connId: string, db: string): Promise<void> {
  const { host, conns, schema } = c;
  const content = await host.pick(
    [
      { label: 'Structure and data', structure: true, data: true },
      { label: 'Structure only', structure: true, data: false },
      { label: 'Data only', structure: false, data: true },
    ],
    { title: `Export ${db} (1/3): content` },
  );
  if (!content) return;
  const tables = await schema.tables(connId, db);
  const pickedTables = await host.pickMany(
    tables.map((x) => ({
      label: x.name,
      description: x.kind === 'view' ? 'view' : [x.rows !== null ? `~${x.rows.toLocaleString()} rows` : '', x.dataBytes ? formatBytes(x.dataBytes) : ''].filter(Boolean).join(' · '),
      picked: true,
      name: x.name,
    })),
    { title: `Export ${db} (2/3): tables`, placeholder: 'All tables are selected' },
  );
  if (!pickedTables) return;
  const opt = (label: string, key: string, picked: boolean, detail?: string) => ({ label, key, picked, detail });
  const extras = await host.pickMany(
    [
      opt('Add DROP … IF EXISTS before each object', 'drop', true),
      opt('Include CREATE DATABASE and USE', 'createDb', false, 'Restores into a database with the same name'),
      opt('Views', 'views', true),
      opt('Stored procedures and functions', 'routines', true),
      opt('Triggers', 'triggers', true),
    ],
    { title: `Export ${db} (3/3): options` },
  );
  if (!extras) return;
  const has = (k: string) => extras.some((e) => e.key === k);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');
  const file = await host.saveFile({ defaultName: `${db}_${stamp}.sql`, filters: { 'SQL dump': ['sql'], 'Gzipped SQL dump': ['gz'] }, saveLabel: 'Export' });
  if (!file) return;
  const conn = await conns.dedicated(connId, db);
  const version = await conns.serverVersion(connId);
  let cancelled = false;
  try {
    const res = await host.withProgress(`Exporting ${db}`, async (progress, token) => {
      token.onCancel(() => (cancelled = true));
      let lastIndex = -1;
      return dumpDatabase(
        conn,
        {
          database: db,
          tables: pickedTables.map((p) => p.name),
          structure: content.structure,
          data: content.data,
          dropTables: has('drop'),
          createDatabase: has('createDb'),
          views: has('views'),
          routines: has('routines'),
          triggers: has('triggers'),
          insertBytes: 1024 * 1024,
          version,
        },
        file,
        (p) => {
          const inc = p.tableIndex !== lastIndex ? 100 / Math.max(1, p.tableCount) : 0;
          lastIndex = p.tableIndex;
          progress.report(`${p.table} (${p.tableIndex + 1}/${p.tableCount})${p.rows ? ` · ${p.rows.toLocaleString()} rows` : ''}`, inc);
        },
        () => cancelled,
      );
    });
    const action = await host.info(`Exported ${db}: ${res.tables} tables, ${res.rows.toLocaleString()} rows → ${path.basename(file)}`, 'Reveal in Folder');
    if (action) await host.revealPath(file);
  } catch (e) {
    if (cancelled) {
      void host.info('Export cancelled.');
      return;
    }
    throw e;
  } finally {
    conn.destroy();
  }
}

/** Runs a .sql / .sql.gz file. Returns true when something was executed. */
export async function importSql(c: Ctx, connId: string, db: string | undefined): Promise<boolean> {
  const { host, conns, schema } = c;
  const cfg = conns.config(connId);
  if (cfg.readOnly) {
    void host.warn(`"${cfg.name}" is read-only.`);
    return false;
  }
  const file = await host.openFile({ filters: { 'SQL files': ['sql', 'gz'], 'All files': ['*'] }, openLabel: 'Import' });
  if (!file) return false;
  const where = db ? `database "${db}"` : `server "${cfg.name}"`;
  const ok = await host.confirm(`Run ${path.basename(file)} on ${where}?`, `${cfg.user}@${cfg.host}:${cfg.port}\nThe file may create, replace or delete data.`, 'Import');
  if (ok !== 'Import') return false;
  const conn = await conns.dedicated(connId, db);
  let cancelled = false;
  try {
    const res = await host.withProgress(`Importing ${path.basename(file)}`, async (progress, token) => {
      token.onCancel(() => (cancelled = true));
      let lastPct = 0;
      return importSqlFile(
        conn,
        file,
        (p) => {
          const pct = (p.bytesRead / Math.max(1, p.totalBytes)) * 100;
          progress.report(
            `${p.statements.toLocaleString()} statements · ${formatBytes(p.bytesRead)} / ${formatBytes(p.totalBytes)}${p.errors ? ` · ${p.errors} errors` : ''}`,
            pct - lastPct,
          );
          lastPct = pct;
        },
        async (sql, err) => {
          const choice = await host.confirm(`Statement failed: ${errorText(err)}`, sql.length > 600 ? sql.slice(0, 600) + '…' : sql, 'Skip', 'Skip All Errors', 'Stop');
          return choice === 'Skip' ? 'skip' : choice === 'Skip All Errors' ? 'skipAll' : 'stop';
        },
        () => cancelled,
      );
    });
    void host.info(`Import finished: ${res.statements.toLocaleString()} statements executed${res.errors ? `, ${res.errors} failed` : ''}.`);
    return true;
  } catch (e) {
    if (cancelled) {
      void host.warn('Import cancelled. Statements already executed were not rolled back.');
      return true;
    }
    throw e;
  } finally {
    schema.invalidate(connId);
    conn.destroy();
  }
}
