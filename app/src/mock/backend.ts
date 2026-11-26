import type { Backend, Cell, Column, Connection, DbObjects, ForeignKey, HistoryEntry, ResultSet, RowChange, TableMeta } from '@/lib/types';

/* An in-memory fake server so the UI can be designed and tested without MySQL. */

interface FakeTable {
  columns: Column[];
  rows: Cell[][];
  kind: 'table' | 'view';
}

const rnd = (() => {
  let s = 42;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
})();
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const pad = (n: number) => String(n).padStart(2, '0');
const dt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const FIRST = ['Aziz', 'Dilnoza', 'Javlon', 'Malika', 'Sardor', 'Nodira', 'Bekzod', 'Gulnora', 'Olivia', 'Liam', 'Emma', 'Noah', 'Sofia', 'Lucas'];
const LAST = ['Karimov', 'Rahimova', 'Yusupov', 'Aliyeva', 'Smith', 'Johnson', 'Brown', 'Garcia', 'Miller', 'Davis'];
const CITIES = ['Tashkent', 'Samarkand', 'Bukhara', 'Andijan', 'Namangan', 'London', 'Berlin', 'Dubai'];
/** A 24×24 gradient PNG, so the value editor's image preview can be tried in the demo. */
const PNG_HEX = '0x89504E470D0A1A0A0000000D4948445200000018000000180806000000E0773DF8000002AB4944415478DA15CD210F904A0000607F8EF145229148245E2412AFB8318B04C3591C9BE58A1BB3483060716C962B6ECCE2050316CBFB11EF7D842F7F2F5EC6DFFFFD43434B47CF4060642232B39058C96CEC1C9C142E2A372F5EBE12D0D0D2D13310189988CC2C2456321B3B0727858BCAFDEA095E0B6868E9E819088C4C446616122B998D9D8393C245E57EFD046F0434B474F40C04462622330B8995CCC6CEC149E1A272BF7982B7021A5A3A7A06022313919985C44A6663E7E0A47051B9DF3EC13B010D2D1D3D03819189C8CC426225B3B1737052B8A8DCEF9EE0BD8086968E9E81C0C844646621B192D9D83938295C54EEF74FF04140434B47CF4060642232B39058C96CEC1C9C142E2AF78727C8021A5A3A7A06022313919985C44A6663E7E0A47051B9F3137C14D0D0D2D13310189988CC2C2456321B3B0727858BCAFDF1093E096868E9E819088C4C446616122B998D9D8393C245E5FEF4049F0534B474F40C04462622330B8995CCC6CEC149E1A2727F7E822F021A5A3A7A06022313919985C44A6663E7E0A47051B9BF3CC157010D2D1D3D03819189C8CC426225B3B1737052B8A8DC5F9FE09B8086968E9E81C0C844646621B192D9D83938295C54EE6F4FF05D40434B47CF4060642232B39058C96CEC1C9C142E2AF7F72728021A5A3A7A06022313919985C44A6663E7E0A47051B9CB13FC10D0D0D2D13310189988CC2C2456321B3B0727858BCAFDE3097E0A6868E9E819088C4C446616122B998D9D8393C245E5FEF904BF0434B474F40C04462622330B8995CCC6CEC149E1A272FF7A82DF021A5A3A7A06022313919985C44A6663E7E0A47051B97F3FC11F010D2D1D3D03819189C8CC426225B3B1737052B8A8DC7F9EE0AF8086968E9E81C0C844646621B192D9D83938295C54EEBF4FF0AF8086968E9E81C0C844646621B192D9D83938295C546EFE071618E57B9DA1254D0000000049454E44AE426082';

const PRODUCTS = ['Espresso', 'Latte', 'Cappuccino', 'Green Tea', 'Croissant', 'Cheesecake', 'Orange Juice', 'Water', 'Bagel', 'Muffin', 'Mocha', 'Americano'];

function makeDb(): Record<string, FakeTable> {
  const now = Date.now();
  const customers: Cell[][] = Array.from({ length: 1240 }, (_, i) => {
    const f = pick(FIRST);
    const l = pick(LAST);
    return [i + 1, `${f} ${l}`, rnd() < 0.08 ? null : `${f.toLowerCase()}.${l.toLowerCase()}${i}@example.com`, pick(CITIES), (rnd() * 4000).toFixed(2), pick(['active', 'active', 'active', 'blocked', 'pending']), rnd() < 0.7 ? 1 : 0, dt(new Date(now - rnd() * 4e10))];
  });
  const products: Cell[][] = PRODUCTS.map((p, i) => [i + 1, p, `SKU-${1000 + i}`, (2 + rnd() * 8).toFixed(2), Math.floor(rnd() * 500), rnd() < 0.3 ? JSON.stringify({ vegan: rnd() < 0.5, sizes: ['S', 'M', 'L'] }) : null, i % 2 ? null : PNG_HEX]);
  const orders: Cell[][] = Array.from({ length: 8650 }, (_, i) => [i + 1, Math.floor(rnd() * 1240) + 1, (5 + rnd() * 120).toFixed(2), pick(['new', 'paid', 'shipped', 'delivered', 'cancelled']), rnd() < 0.15 ? 'Leave at the door' : null, dt(new Date(now - rnd() * 2e10))]);
  return {
    customers: {
      kind: 'table',
      columns: [
        { name: 'id', type: 'int unsigned', pk: true, autoIncrement: true, numeric: true, nullable: false },
        { name: 'full_name', type: 'varchar(120)', nullable: false },
        { name: 'email', type: 'varchar(190)', nullable: true },
        { name: 'city', type: 'varchar(60)', nullable: true },
        { name: 'balance', type: 'decimal(12,2)', numeric: true, nullable: false, defaultValue: '0.00' },
        { name: 'status', type: "enum('active','blocked','pending')", options: ['active', 'blocked', 'pending'], nullable: false, defaultValue: 'active' },
        { name: 'is_vip', type: 'tinyint(1)', numeric: true, nullable: false, defaultValue: '0' },
        { name: 'created_at', type: 'datetime', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      rows: customers,
    },
    orders: {
      kind: 'table',
      columns: [
        { name: 'id', type: 'bigint unsigned', pk: true, autoIncrement: true, numeric: true, nullable: false },
        { name: 'customer_id', type: 'int unsigned', numeric: true, nullable: false },
        { name: 'total', type: 'decimal(10,2)', numeric: true, nullable: false },
        { name: 'status', type: "enum('new','paid','shipped','delivered','cancelled')", options: ['new', 'paid', 'shipped', 'delivered', 'cancelled'], nullable: false },
        { name: 'note', type: 'text', nullable: true },
        { name: 'created_at', type: 'datetime', nullable: false },
      ],
      rows: orders,
    },
    products: {
      kind: 'table',
      columns: [
        { name: 'id', type: 'int', pk: true, autoIncrement: true, numeric: true, nullable: false },
        { name: 'name', type: 'varchar(100)', nullable: false },
        { name: 'sku', type: 'varchar(30)', nullable: false },
        { name: 'price', type: 'decimal(8,2)', numeric: true, nullable: false },
        { name: 'stock', type: 'int', numeric: true, nullable: false },
        { name: 'attributes', type: 'json', nullable: true },
        { name: 'photo', type: 'mediumblob', binary: true, nullable: true },
      ],
      rows: products,
    },
    active_customers: {
      kind: 'view',
      columns: [
        { name: 'id', type: 'int unsigned', numeric: true },
        { name: 'full_name', type: 'varchar(120)' },
        { name: 'city', type: 'varchar(60)' },
      ],
      rows: customers.filter((c) => c[5] === 'active').map((c) => [c[0], c[1], c[3]]),
    },
  };
}

const servers: Record<string, Record<string, Record<string, FakeTable>>> = {
  local: { shop_db: makeDb(), analytics: { events: { kind: 'table', columns: [{ name: 'id', type: 'bigint', pk: true, numeric: true }, { name: 'name', type: 'varchar(50)' }, { name: 'payload', type: 'json' }], rows: Array.from({ length: 300 }, (_, i) => [i + 1, pick(['page_view', 'click', 'signup', 'purchase']), JSON.stringify({ path: '/p/' + i })]) } } },
  prod: { shop_db: makeDb() },
};

let connections: Connection[] = [
  { id: 'local', name: 'Local MySQL', color: 'green', host: '127.0.0.1', port: 3306, user: 'root', database: 'shop_db' },
  { id: 'prod', name: 'Production', color: 'red', host: '10.0.4.12', port: 3306, user: 'app', database: 'shop_db', readOnly: true, ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'key', keyPath: '~/.ssh/id_ed25519' } },
  { id: 'staging', name: 'Staging', color: 'yellow', host: 'staging-db.internal', port: 3306, user: 'app' },
];

const delay = (ms = 60 + rnd() * 120) => new Promise((r) => setTimeout(r, ms));
const db = (id: string, name: string) => {
  const d = servers[id]?.[name];
  if (!d) throw new Error(`Unknown database '${name}'`);
  return d;
};

function lit(v: Cell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(v)) return String(v);
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** A tiny WHERE evaluator: a = 1, a LIKE '%x%', a > 2, a IS NULL, combined with AND. */
function matcher(cols: Column[], where: string): (r: Cell[]) => boolean {
  if (!where.trim()) return () => true;
  const parts = where.split(/\s+and\s+/i).map((p) => p.trim());
  const tests = parts.map((p) => {
    const m = /^(?:\w+\.)?`?(\w+)`?\s*(=|!=|<>|>=|<=|>|<|like|is not|is)\s*(.+)$/i.exec(p);
    if (!m) throw new Error(`Unsupported filter in demo: ${p}`);
    const i = cols.findIndex((c) => c.name === m[1]);
    if (i < 0) throw new Error(`ER_BAD_FIELD_ERROR: Unknown column '${m[1]}' in 'where clause'`);
    const op = m[2].toLowerCase();
    const raw = m[3].trim().replace(/^'(.*)'$/, '$1');
    return (r: Cell[]) => {
      const v = r[i];
      if (op === 'is') return v === null;
      if (op === 'is not') return v !== null;
      if (v === null) return false;
      if (op === 'like') return new RegExp('^' + raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(String(v));
      const a = Number(v);
      const b = Number(raw);
      const num = !Number.isNaN(a) && !Number.isNaN(b);
      const x = num ? a : String(v);
      const y = num ? b : raw;
      switch (op) {
        case '=': return x == y;
        case '!=': case '<>': return x != y;
        case '>': return x > y;
        case '<': return x < y;
        case '>=': return x >= y;
        default: return x <= y;
      }
    };
  });
  return (r) => tests.every((t) => t(r));
}

/** The demo's foreign keys: every order belongs to a customer. */
const FOREIGN_KEYS: ForeignKey[] = [{ name: 'fk_orders_customer', db: 'shop_db', table: 'orders', columns: ['customer_id'], refDb: 'shop_db', refTable: 'customers', refColumns: ['id'] }];

function hexToBase64(hex: string): string {
  const body = hex.replace(/^0x/i, '');
  let bin = '';
  for (let i = 0; i < body.length; i += 2) bin += String.fromCharCode(parseInt(body.slice(i, i + 2), 16));
  return btoa(bin);
}

let history: HistoryEntry[] = [];
const cancelled = new Set<string>();

/** CREATE TABLE text for a fake table, shaped like MySQL's SHOW CREATE TABLE output. */
function fakeDdl(table: string, columns: Column[]): string {
  const lines = columns.map(
    (c) =>
      `  \`${c.name}\` ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.autoIncrement ? ' AUTO_INCREMENT' : c.defaultValue != null ? ` DEFAULT ${c.defaultValue === 'CURRENT_TIMESTAMP' ? c.defaultValue : `'${c.defaultValue}'`}` : c.nullable ? ' DEFAULT NULL' : ''}`,
  );
  const pk = columns.filter((c) => c.pk).map((c) => `\`${c.name}\``);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(',')})`);
  return `CREATE TABLE \`${table}\` (\n${lines.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

export const mockBackend: Backend = {
  native: false,
  async listConnections() {
    await delay(20);
    return connections;
  },
  async saveConnection(c) {
    await delay();
    const i = connections.findIndex((x) => x.id === c.id);
    if (i >= 0) connections[i] = c;
    else connections = [...connections, c];
    if (!servers[c.id]) servers[c.id] = { shop_db: makeDb() };
    return c;
  },
  async deleteConnection(id) {
    connections = connections.filter((c) => c.id !== id);
  },
  async testConnection(c) {
    await delay(500);
    if (c.host.includes('bad')) throw new Error(`ECONNREFUSED: connect to ${c.host}:${c.port} refused`);
    return '8.0.36 MySQL Community Server';
  },
  async connect(id) {
    await delay(250);
    if (id === 'staging') throw new Error("ER_ACCESS_DENIED_ERROR: Access denied for user 'app'@'10.0.0.5' (using password: YES)");
  },
  async disconnect() {
    await delay(20);
  },
  async databases(id) {
    await delay();
    return Object.keys(servers[id] ?? {});
  },
  async objects(id, name): Promise<DbObjects> {
    await delay();
    const d = db(id, name);
    const tables: TableMeta[] = Object.entries(d).map(([t, v]) => ({ name: t, kind: v.kind, rows: v.rows.length, bytes: v.rows.length * 96 + 16384 }));
    return { tables, routines: name === 'shop_db' ? [{ name: 'refresh_stats', kind: 'procedure' }, { name: 'order_total', kind: 'function' }] : [], triggers: name === 'shop_db' ? ['orders_before_insert'] : [] };
  },
  async columns(id, name, table) {
    await delay(30);
    return db(id, name)[table].columns;
  },
  async schema(id, name) {
    await delay(30);
    return Object.fromEntries(Object.entries(db(id, name)).map(([t, v]) => [t, v.columns]));
  },
  async tablePage(id, name, table, req) {
    const started = performance.now();
    await delay();
    const t = db(id, name)[table];
    let rows = t.rows.filter(matcher(t.columns, req.filter));
    if (req.sort) {
      const i = t.columns.findIndex((c) => c.name === req.sort!.column);
      const num = t.columns[i]?.numeric;
      rows = [...rows].sort((a, b) => {
        const x = a[i];
        const y = b[i];
        if (x === y) return 0;
        if (x === null) return -1;
        if (y === null) return 1;
        const c = num ? Number(x) - Number(y) : String(x).localeCompare(String(y));
        return req.sort!.dir === 'asc' ? c : -c;
      });
    }
    return {
      columns: t.columns,
      rows: rows.slice(req.page * req.pageSize, (req.page + 1) * req.pageSize).map((r) => [...r]),
      total: rows.length,
      keyColumns: t.kind === 'table' ? t.columns.filter((c) => c.pk).map((c) => c.name) : [],
      ms: Math.round(performance.now() - started),
    };
  },
  async foreignKeys(_id, name, table) {
    await delay(30);
    return { outgoing: FOREIGN_KEYS.filter((f) => f.db === name && f.table === table), incoming: FOREIGN_KEYS.filter((f) => f.refDb === name && f.refTable === table) };
  },
  async countRows(id, items, cap) {
    await delay(40);
    return items.map((it) => {
      try {
        const t = db(id, it.db)[it.table];
        return Math.min(cap, t.rows.filter(matcher(t.columns, it.filter)).length);
      } catch {
        return null;
      }
    });
  },
  async cellBytes(r) {
    await delay(40);
    const t = db(r.connId, r.db)[r.table];
    const ci = t.columns.findIndex((c) => c.name === r.column);
    const row = t.rows.find((x) => Object.entries(r.key).every(([k, v]) => x[t.columns.findIndex((c) => c.name === k)] == v));
    if (!row) throw new Error('Row was not found. Reload and try again.');
    const v = row[ci];
    return typeof v === 'string' && /^0x[0-9a-f]*$/i.test(v) ? hexToBase64(v) : btoa(unescape(encodeURIComponent(String(v ?? ''))));
  },
  async saveCell(r, suggestedName) {
    const b64 = await this.cellBytes(r);
    return { bytes: Math.floor((b64.length * 3) / 4), path: `C:\\Users\\you\\Downloads\\${suggestedName}` };
  },
  async loadFileHex() {
    await delay(100);
    return PNG_HEX;
  },
  async query(id, name, input, runId) {
    const out: ResultSet[] = [];
    const sql = Array.isArray(input) ? input.join(';\n') : input;
    const stmts = Array.isArray(input) ? input.map((s) => s.trim()).filter(Boolean) : sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      const started = performance.now();
      // SELECT SLEEP(n) waits n seconds, so Cancel can be tried in the demo.
      const sleep = /^select\s+sleep\((\d+(?:\.\d+)?)\)$/i.exec(stmt);
      for (let t = 0; t < (sleep ? Number(sleep[1]) * 10 : 1); t++) {
        if (runId && cancelled.has(runId)) break;
        await delay(sleep ? 100 : undefined);
      }
      if (runId && cancelled.has(runId)) {
        out.push({ kind: 'error', sql: stmt, columns: [], rows: [], totalRows: 0, error: 'Query cancelled.', ms: Math.round(performance.now() - started) });
        break;
      }
      if (sleep) {
        out.push({ kind: 'rows', sql: stmt, columns: [{ name: stmt.slice(7), type: 'bigint', numeric: true }], rows: [[0]], totalRows: 1, ms: Math.round(performance.now() - started) });
        continue;
      }
      try {
        const m = /^select\s+(.+?)\s+from\s+`?(\w+)`?(?:\s+(?:as\s+)?\w+)?(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+`?(\w+)`?(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?\s*$/is.exec(stmt);
        const ddl = /^show\s+create\s+(table|view)\s+(?:`?\w+`?\.)?`?(\w+)`?$/i.exec(stmt);
        if (ddl) {
          const t = db(id, name ?? 'shop_db')[ddl[2]];
          if (!t) throw new Error(`ER_NO_SUCH_TABLE: Table '${name}.${ddl[2]}' doesn't exist`);
          const kind = ddl[1].toLowerCase() === 'view' ? 'View' : 'Table';
          out.push({ kind: 'rows', sql: stmt, columns: [{ name: kind, type: 'varchar' }, { name: `Create ${kind}`, type: 'text' }], rows: [[ddl[2], fakeDdl(ddl[2], t.columns)]], totalRows: 1, ms: Math.round(performance.now() - started) });
          continue;
        }
        if (/^(update|delete|insert)/i.test(stmt)) {
          out.push({ kind: 'ok', sql: stmt, columns: [], rows: [], totalRows: 0, affectedRows: Math.floor(rnd() * 5) + 1, ms: Math.round(performance.now() - started) });
          continue;
        }
        if (!m) throw new Error('This demo understands simple SELECT … FROM … WHERE … ORDER BY … LIMIT queries.');
        const t = db(id, name ?? 'shop_db')[m[2]];
        if (!t) throw new Error(`ER_NO_SUCH_TABLE: Table '${name}.${m[2]}' doesn't exist`);
        let rows = t.rows.filter(matcher(t.columns, m[3] ?? ''));
        const want = m[1].trim() === '*' ? t.columns.map((_, i) => i) : m[1].split(',').map((c) => t.columns.findIndex((x) => x.name === c.trim().replace(/^\w+\./, '').replace(/`/g, '')));
        if (want.some((i) => i < 0)) throw new Error('ER_BAD_FIELD_ERROR: Unknown column in field list');
        if (m[4]) {
          const i = t.columns.findIndex((c) => c.name === m[4]);
          rows = [...rows].sort((a, b) => (Number(a[i]) - Number(b[i]) || String(a[i]).localeCompare(String(b[i]))) * (m[5]?.toLowerCase() === 'desc' ? -1 : 1));
        }
        const total = rows.length;
        if (m[6]) rows = rows.slice(0, Number(m[6]));
        out.push({ kind: 'rows', sql: stmt, columns: want.map((i) => t.columns[i]), rows: rows.slice(0, 5000).map((r) => want.map((i) => r[i])), totalRows: Math.min(total, m[6] ? Number(m[6]) : total), ms: Math.round(performance.now() - started) });
      } catch (e) {
        out.push({ kind: 'error', sql: stmt, columns: [], rows: [], totalRows: 0, error: (e as Error).message, ms: Math.round(performance.now() - started) });
        break;
      }
    }
    if (runId) cancelled.delete(runId);
    const err = out.find((r) => r.kind === 'error');
    history.push({
      id: `h${Date.now()}${history.length}`,
      ts: Date.now(),
      connId: id,
      connName: connections.find((c) => c.id === id)?.name ?? '',
      db: name || undefined,
      sql: sql.trim(),
      ms: out.reduce((a, r) => a + r.ms, 0),
      rows: out.reduce((a, r) => a + (r.kind === 'rows' ? r.totalRows : 0), 0),
      affected: out.reduce((a, r) => a + (r.affectedRows ?? 0), 0),
      error: err?.error,
    });
    return out;
  },
  async cancelQuery(runId) {
    cancelled.add(runId);
    return true;
  },
  async loadSession() {
    try {
      return localStorage.getItem('demo-session');
    } catch {
      return null;
    }
  },
  async saveSession(json) {
    try {
      localStorage.setItem('demo-session', json);
    } catch {
      // ignore: the demo simply starts fresh
    }
  },
  async historyList() {
    return [...history].reverse();
  },
  async historyDelete(hid) {
    history = history.filter((h) => h.id !== hid);
  },
  async historyClear() {
    history = [];
  },
  async exportConnections() {
    await delay(200);
    return { count: connections.length, path: 'C:\\Users\\you\\Downloads\\mysql-connections.json' };
  },
  async importConnections() {
    await delay(200);
    return { added: 0, skipped: connections.length };
  },
  async previewChanges(_id, name, table, columns, changes) {
    const t = `\`${name}\`.\`${table}\``;
    const where = (k: Record<string, Cell>) => Object.entries(k).map(([c, v]) => `\`${c}\` = ${lit(v)}`).join(' AND ');
    void columns;
    return changes.map((c) =>
      c.kind === 'update'
        ? `UPDATE ${t} SET ${Object.entries(c.values).map(([k, v]) => `\`${k}\` = ${lit(v)}`).join(', ')} WHERE ${where(c.key)} LIMIT 1;`
        : c.kind === 'delete'
          ? `DELETE FROM ${t} WHERE ${where(c.key)} LIMIT 1;`
          : `INSERT INTO ${t} (${Object.keys(c.values).map((k) => `\`${k}\``).join(', ')}) VALUES (${Object.values(c.values).map(lit).join(', ')});`,
    );
  },
  async exportData(_id, _db, table, _sql, format) {
    await delay(400);
    return { rows: 1240, path: `C:\\Users\\you\\Downloads\\${table}.${format === 'markdown' ? 'md' : format}` };
  },
  async revealFile() {},
  async dumpDatabase(_id, o, onProgress) {
    for (let i = 0; i < o.tables.length; i++) {
      onProgress(`${o.tables[i]} (${i + 1}/${o.tables.length})`);
      await delay(250);
    }
    return { tables: o.tables.length, rows: 10002, path: `C:\\Users\\you\\Downloads\\${o.database}.sql${o.gzip ? '.gz' : ''}` };
  },
  async pickDataFile() {
    return 'customers_2025.csv';
  },
  async importPreview(path, opts) {
    await delay(150);
    const rows = Array.from({ length: 40 }, (_, i) => [String(i + 1), `Mijoz ${i}`, i % 5 ? `m${i}@mail.uz` : '', (i * 12.5).toFixed(2), `2025-01-${String(10 + (i % 20)).padStart(2, '0')}`]);
    return { fileName: path, fileKind: 'csv', sourceColumns: ['ID', 'Full Name', 'E-mail', 'Balance', 'Created'], rows, rowCount: null, sheets: [], options: opts ?? { delimiter: ';', header: true, encoding: 'utf8' }, inferredTypes: ['INT', 'VARCHAR(100)', 'VARCHAR(100)', 'DECIMAL(12,2)', 'DATE'] };
  },
  async importData(_id, _db, _path, _opts, _plan, onProgress) {
    for (let i = 1; i <= 5; i++) {
      onProgress(i * 500);
      await delay(200);
    }
    return 2500;
  },
  async importSql(_id, _db, _c, onProgress) {
    for (let i = 1; i <= 4; i++) {
      onProgress(`${i * 25}% · ${i * 120} statements`);
      await delay(300);
    }
    return { statements: 480, errors: [], file: 'backup.sql' };
  },
  async applyChanges(id, name, table, _columns, changes: RowChange[]) {
    await delay(200);
    const t = db(id, name)[table];
    const pkI = t.columns.findIndex((c) => c.pk);
    const pk = t.columns[pkI].name;
    for (const c of changes) {
      if (c.kind === 'update') {
        const r = t.rows.find((x) => x[pkI] == c.key[pk]);
        if (!r) throw new Error('Row not found. It may have been deleted by someone else.');
        for (const [k, v] of Object.entries(c.values)) r[t.columns.findIndex((x) => x.name === k)] = v;
      } else if (c.kind === 'delete') {
        t.rows = t.rows.filter((x) => x[pkI] != c.key[pk]);
      } else {
        const next = Math.max(0, ...t.rows.map((r) => Number(r[pkI]))) + 1;
        t.rows.unshift(t.columns.map((col) => (col.pk ? next : col.name in c.values ? c.values[col.name] : (col.defaultValue === 'CURRENT_TIMESTAMP' ? dt(new Date()) : (col.defaultValue ?? null)))));
      }
    }
  },
};
