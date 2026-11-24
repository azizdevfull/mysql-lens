import { ConnectionManager } from './connections/manager';
import type { ColumnInfo } from './shared/protocol';
import { NUMERIC_TYPES, qualified } from './sql';

export const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export interface TableMeta {
  name: string;
  kind: 'table' | 'view';
  rows: number | null;
  dataBytes: number | null;
  comment: string;
  engine: string | null;
}

export interface ColumnMeta {
  name: string;
  columnType: string;
  dataType: string;
  nullable: boolean;
  key: string;
  defaultValue: string | null;
  extra: string;
  comment: string;
}

export interface IndexMeta {
  name: string;
  unique: boolean;
  columns: string[];
  type: string;
}

export interface RoutineMeta {
  name: string;
  kind: 'procedure' | 'function';
}

/** Reads schema information and caches it per connection/database. */
export class SchemaService {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly conns: ConnectionManager,
    private readonly showSystemDatabases: () => boolean = () => false,
  ) {
    conns.onDidChangeState((id) => this.invalidate(id));
  }

  invalidate(connId: string, db?: string): void {
    const prefix = db === undefined ? `${connId}|` : `${connId}|${db}|`;
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(prefix) || (db !== undefined && k === `${connId}|dbs`)) {
        this.cache.delete(k);
      }
    }
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  databases(connId: string): Promise<string[]> {
    return this.cached(`${connId}|dbs`, async () => {
      const rows = await this.conns.query<{ Database: string }[]>(connId, 'SHOW DATABASES');
      const showSystem = this.showSystemDatabases();
      return rows.map((r) => r.Database).filter((d) => showSystem || !SYSTEM_DATABASES.has(d.toLowerCase()));
    });
  }

  tables(connId: string, db: string): Promise<TableMeta[]> {
    return this.cached(`${connId}|${db}|tables`, async () => {
      const rows = await this.conns.query<Record<string, unknown>[]>(
        connId,
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS \`rows\`, DATA_LENGTH + INDEX_LENGTH AS bytes,
                TABLE_COMMENT AS comment, ENGINE AS engine
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [db],
      );
      return rows.map((r) => ({
        name: String(r.name),
        kind: String(r.type).includes('VIEW') ? 'view' : 'table',
        rows: r.rows === null ? null : Number(r.rows),
        dataBytes: r.bytes === null ? null : Number(r.bytes),
        comment: String(r.comment ?? ''),
        engine: (r.engine as string) ?? null,
      }));
    });
  }

  columns(connId: string, db: string, table: string): Promise<ColumnMeta[]> {
    return this.cached(`${connId}|${db}|cols|${table}`, async () => {
      const rows = await this.conns.query<Record<string, unknown>[]>(
        connId,
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS columnType, DATA_TYPE AS dataType, IS_NULLABLE AS nullable,
                COLUMN_KEY AS \`key\`, COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [db, table],
      );
      return rows.map((r) => ({
        name: String(r.name),
        columnType: String(r.columnType),
        dataType: String(r.dataType),
        nullable: r.nullable === 'YES',
        key: String(r.key ?? ''),
        defaultValue: r.def === null || r.def === undefined ? null : String(r.def),
        extra: String(r.extra ?? ''),
        comment: String(r.comment ?? ''),
      }));
    });
  }

  /** All columns of a database, grouped by table (for autocomplete). */
  allColumns(connId: string, db: string): Promise<Map<string, { name: string; type: string; pk: boolean }[]>> {
    return this.cached(`${connId}|${db}|allcols`, async () => {
      const rows = await this.conns.query<{ t: string; c: string; ty: string; k: string }[]>(
        connId,
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, COLUMN_KEY AS k
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [db],
      );
      const map = new Map<string, { name: string; type: string; pk: boolean }[]>();
      for (const r of rows) {
        const list = map.get(r.t) ?? [];
        list.push({ name: r.c, type: String(r.ty), pk: r.k === 'PRI' });
        map.set(r.t, list);
      }
      return map;
    });
  }

  indexes(connId: string, db: string, table: string): Promise<IndexMeta[]> {
    return this.cached(`${connId}|${db}|idx|${table}`, async () => {
      const rows = await this.conns.query<Record<string, unknown>[]>(connId, `SHOW INDEX FROM ${qualified(db, table)}`);
      const map = new Map<string, IndexMeta>();
      for (const r of rows) {
        const name = String(r.Key_name);
        const idx = map.get(name) ?? { name, unique: Number(r.Non_unique) === 0, columns: [], type: String(r.Index_type ?? '') };
        idx.columns.push(String(r.Column_name ?? r.Expression ?? '?'));
        map.set(name, idx);
      }
      return [...map.values()];
    });
  }

  routines(connId: string, db: string): Promise<RoutineMeta[]> {
    return this.cached(`${connId}|${db}|routines`, async () => {
      const rows = await this.conns.query<{ name: string; type: string }[]>(
        connId,
        'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
        [db],
      );
      return rows.map((r) => ({ name: r.name, kind: r.type === 'FUNCTION' ? 'function' : 'procedure' }));
    });
  }

  triggers(connId: string, db: string): Promise<string[]> {
    return this.cached(`${connId}|${db}|triggers`, async () => {
      const rows = await this.conns.query<{ name: string }[]>(
        connId,
        'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
        [db],
      );
      return rows.map((r) => r.name);
    });
  }

  /** Column metadata in the grid's format, plus the columns that identify a row. */
  async gridColumns(connId: string, db: string, table: string): Promise<{ columns: ColumnInfo[]; keyColumns: string[] }> {
    const [cols, idx] = await Promise.all([this.columns(connId, db, table), this.indexes(connId, db, table)]);
    const columns: ColumnInfo[] = cols.map((c) => ({
      name: c.name,
      type: c.columnType,
      table,
      pk: c.key === 'PRI',
      nullable: c.nullable,
      autoIncrement: /auto_increment/i.test(c.extra),
      numeric: NUMERIC_TYPES.has(c.dataType.toUpperCase()) || /^(decimal|float|double)$/i.test(c.dataType),
      binary: /binary|blob|bit/i.test(c.dataType),
      defaultValue: c.defaultValue,
      comment: c.comment,
      options: /^(enum|set)\(/i.test(c.columnType) ? parseEnum(c.columnType) : undefined,
    }));
    const primary = idx.find((i) => i.name === 'PRIMARY');
    const notNull = new Set(cols.filter((c) => !c.nullable).map((c) => c.name));
    const unique = idx.find((i) => i.unique && i.columns.every((c) => notNull.has(c)));
    return { columns, keyColumns: (primary ?? unique)?.columns ?? [] };
  }

  async createStatement(connId: string, db: string, kind: string, name: string): Promise<string> {
    const what = kind.toUpperCase();
    const rows = await this.conns.query<Record<string, string>[]>(connId, `SHOW CREATE ${what} ${qualified(db, name)}`);
    const row = rows[0] ?? {};
    const key = Object.keys(row).find((k) => /^Create (Table|View|Procedure|Function|Trigger)$/i.test(k) || k === 'SQL Original Statement');
    return key ? row[key] : '';
  }
}

export function parseEnum(columnType: string): string[] {
  const inner = columnType.slice(columnType.indexOf('(') + 1, columnType.lastIndexOf(')'));
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    out.push(m[1].replace(/''/g, "'"));
  }
  return out;
}

