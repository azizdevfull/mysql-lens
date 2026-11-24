/**
 * Integration tests against a real MySQL server.
 * Env: MSTUDIO_HOST, MSTUDIO_PORT, MSTUDIO_USER, MSTUDIO_PASSWORD (defaults match the local test user).
 * Databases mstudio_test and mstudio_restore must exist and be writable.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as mysql from 'mysql2';
import { buildOptions, connectOnce, runQuery } from '../src/connections/driver';
import { defaultConfig } from '../src/connections/types';
import { splitSql, SqlSplitter, statementAt } from '../src/query/splitter';
import { executeStatement } from '../src/query/executor';
import { dumpDatabase } from '../src/io/dump';
import { importSqlFile } from '../src/io/sqlImport';
import { createWriter, exportCell, streamQuery } from '../src/io/exporters';
import { detectOptions, preview, runDataImport, inferType } from '../src/io/dataImport';
import { cellLiteral } from '../src/sql';
import type { ExportFormat, ImportPlan } from '../src/shared/protocol';

const DB = 'mstudio_test';
const RESTORE = 'mstudio_restore';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstudio-'));
let conn: mysql.Connection;

async function open(database?: string): Promise<mysql.Connection> {
  const cfg = {
    ...defaultConfig(),
    id: 't',
    host: process.env.MSTUDIO_HOST ?? '127.0.0.1',
    port: Number(process.env.MSTUDIO_PORT ?? 3306),
    user: process.env.MSTUDIO_USER ?? 'mstudio',
  };
  const opts = await buildOptions(cfg, { password: process.env.MSTUDIO_PASSWORD ?? 'Mstudio_pass1' });
  return connectOnce({ ...opts, database });
}

async function resetDb(c: mysql.Connection, db: string) {
  const rows = await runQuery<{ n: string; t: string }[]>(c, 'SELECT TABLE_NAME n, TABLE_TYPE t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [db]);
  await runQuery(c, 'SET FOREIGN_KEY_CHECKS=0');
  for (const r of rows) {
    await runQuery(c, `DROP ${r.t.includes('VIEW') ? 'VIEW' : 'TABLE'} IF EXISTS \`${db}\`.\`${r.n}\``);
  }
  const routines = await runQuery<{ n: string; t: string }[]>(c, 'SELECT ROUTINE_NAME n, ROUTINE_TYPE t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [db]);
  for (const r of routines) {
    await runQuery(c, `DROP ${r.t} IF EXISTS \`${db}\`.\`${r.n}\``);
  }
  await runQuery(c, 'SET FOREIGN_KEY_CHECKS=1');
}

const TRICKY = [
  "it's",
  'back\\slash',
  'semi;colon -- not a comment',
  'line1\nline2\r\nline3',
  'emoji 😀 and Oʻzbek: Gʻ, ш, ё',
  '"double" `tick`',
  '',
  'tab\there',
  '/* not a comment */',
  'DELIMITER ;;',
];

before(async () => {
  conn = await open(DB);
  await resetDb(conn, DB);
  await resetDb(conn, RESTORE);
  await runQuery(
    conn,
    `CREATE TABLE items (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      price DECIMAL(12,4) NULL,
      qty BIGINT NULL,
      ratio DOUBLE NULL,
      note TEXT NULL,
      meta JSON NULL,
      data BLOB NULL,
      uid BINARY(16) NULL,
      created DATETIME(3) NULL,
      ts TIMESTAMP NULL DEFAULT NULL,
      day DATE NULL,
      flag BIT(1) NULL,
      kind ENUM('a','b','c''q') NULL,
      tags SET('x','y','z') NULL,
      name_len INT AS (CHAR_LENGTH(name)) VIRTUAL,
      KEY idx_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  await runQuery(conn, `CREATE TABLE child (id INT PRIMARY KEY, item_id INT UNSIGNED, FOREIGN KEY (item_id) REFERENCES items(id))`);
  for (let i = 0; i < TRICKY.length; i++) {
    await runQuery(
      conn,
      `INSERT INTO items (name, price, qty, ratio, note, meta, data, uid, created, ts, day, flag, kind, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, UNHEX(REPLACE(UUID(),'-','')), ?, ?, ?, b'1', ?, ?)`,
      [
        TRICKY[i],
        (i * 1.2345).toFixed(4),
        String(9007199254740993n + BigInt(i)),
        i / 3,
        TRICKY[(i + 3) % TRICKY.length],
        JSON.stringify({ i, s: TRICKY[i], nested: { arr: [1, 2, 'x'] } }),
        Buffer.from([0, 1, 2, 255, 39, 92, i]),
        '2025-03-04 05:06:07.123',
        '2025-03-04 05:06:07',
        '2025-03-04',
        ['a', 'b', "c'q"][i % 3],
        'x,z',
      ],
    );
  }
  await runQuery(conn, `INSERT INTO items (name) VALUES ('all nulls')`);
  await runQuery(conn, `INSERT INTO child VALUES (1, 1), (2, 2)`);
  await runQuery(conn, `CREATE VIEW v_items AS SELECT id, name FROM items WHERE price > 1`);
  await runQuery(conn, `CREATE PROCEDURE two_sets() BEGIN SELECT 1 AS a; SELECT 'x' AS b, 2 AS c; END`);
  await runQuery(conn, `CREATE FUNCTION add_one(x INT) RETURNS INT DETERMINISTIC RETURN x + 1`);
  await runQuery(conn, `CREATE TRIGGER trg_items BEFORE INSERT ON items FOR EACH ROW BEGIN IF NEW.name = '' THEN SET NEW.name = '(empty)'; END IF; END`);
  // Bulk rows so dumps produce several INSERT batches.
  await runQuery(conn, `CREATE TABLE bulk (id INT PRIMARY KEY, v VARCHAR(50))`);
  const values = Array.from({ length: 5000 }, (_, i) => `(${i}, 'value ${i} ''q''')`).join(',');
  await runQuery(conn, `INSERT INTO bulk VALUES ${values}`);
});

after(async () => {
  conn?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ---------------------------- splitter ---------------------------- */

test('splitter: quotes, comments, delimiters', () => {
  const sql = `SELECT 'a;b' AS x; -- c;omment
SELECT "q\\";" , \`we;ird\` FROM t; # hash; comment
/* block ; */ SELECT 1;
DELIMITER $$
CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$
DELIMITER ;
SELECT 'it''s';
SELECT 3`;
  const st = splitSql(sql).map((s) => s.sql);
  assert.equal(st.length, 6, JSON.stringify(st, null, 1));
  assert.equal(st[0], "SELECT 'a;b' AS x");
  assert.match(st[1], /we;ird/);
  assert.match(st[2], /SELECT 1$/);
  assert.equal(st[3], 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END');
  assert.equal(st[4], "SELECT 'it''s'");
  assert.equal(st[5], 'SELECT 3');
});

test('splitter: chunked input gives the same result as whole input', () => {
  const sql = fs.readFileSync(__filename, 'utf8').slice(0, 20000) + "\nSELECT 'tail;';";
  const whole = splitSql(sql).map((s) => s.sql);
  for (const size of [1, 3, 7, 64, 1000]) {
    const sp = new SqlSplitter();
    const out: string[] = [];
    for (let i = 0; i < sql.length; i += size) out.push(...sp.push(sql.slice(i, i + size)).map((s) => s.sql));
    out.push(...sp.end().map((s) => s.sql));
    assert.deepEqual(out, whole, `chunk size ${size}`);
  }
});

test('splitter: offsets and statementAt', () => {
  const text = 'SELECT 1;\n\nSELECT 2;\nSELECT\n  3';
  const all = splitSql(text);
  for (const s of all) assert.equal(text.slice(s.start, s.end), s.sql);
  assert.equal(statementAt(text, 0)?.sql, 'SELECT 1');
  assert.equal(statementAt(text, 13)?.sql, 'SELECT 2');
  assert.equal(statementAt(text, text.length)?.sql, 'SELECT\n  3');
  assert.equal(statementAt(text, 10)?.sql, 'SELECT 1'); // blank line after first statement
});

test('splitter: comment-only input yields nothing', () => {
  assert.deepEqual(splitSql('-- just a comment\n/* block */\n# hash'), []);
  assert.equal(splitSql('/*!40101 SET NAMES utf8mb4 */;').length, 1);
});

/* ---------------------------- executor ---------------------------- */

test('executor: column metadata and values', async () => {
  const [r] = await executeStatement(conn, 'SELECT * FROM items ORDER BY id', 1000);
  assert.equal(r.kind, 'rows');
  const col = (n: string) => r.columns.find((c) => c.name === n)!;
  assert.equal(col('id').pk, true);
  assert.equal(col('id').autoIncrement, true);
  assert.equal(col('id').numeric, true);
  assert.equal(col('price').numeric, true);
  assert.equal(col('name').numeric, false);
  assert.equal(col('data').binary, true);
  assert.equal(col('uid').binary, true);
  assert.equal(col('note').binary, false);
  assert.equal(col('meta').type, 'JSON');
  assert.equal(r.rows.length, TRICKY.length + 1);
  const name = r.columns.indexOf(col('name'));
  assert.deepEqual(r.rows.slice(0, TRICKY.length).map((x) => x[name]), TRICKY);
  const qty = r.columns.indexOf(col('qty'));
  assert.equal(r.rows[0][qty], '9007199254740993', 'BIGINT keeps precision');
  const meta = r.columns.indexOf(col('meta'));
  assert.equal(typeof r.rows[0][meta], 'string');
  assert.deepEqual(JSON.parse(r.rows[0][meta] as string).nested.arr, [1, 2, 'x']);
  const created = r.columns.indexOf(col('created'));
  assert.equal(r.rows[0][created], '2025-03-04 05:06:07.123');
  const data = r.columns.indexOf(col('data'));
  assert.equal(r.rows[0][data], '0x000102FF275C00');
  const last = r.rows[r.rows.length - 1];
  assert.equal(last[col('price') ? r.columns.indexOf(col('price')) : 0], null);
});

test('executor: row limit, multiple result sets, errors, OK packets', async () => {
  const [big] = await executeStatement(conn, 'SELECT * FROM bulk', 100);
  assert.equal(big.rows.length, 100);
  assert.equal(big.totalRows, 5000);
  assert.equal(big.truncated, true);

  const sets = await executeStatement(conn, 'CALL two_sets()', 100);
  assert.equal(sets.length, 2, JSON.stringify(sets.map((s) => s.kind)));
  assert.deepEqual(sets[1].columns.map((c) => c.name), ['b', 'c']);

  const [err] = await executeStatement(conn, 'SELECT * FROM nope', 10);
  assert.equal(err.kind, 'error');
  assert.match(err.error!, /ER_NO_SUCH_TABLE/);

  const [ok] = await executeStatement(conn, "UPDATE bulk SET v = v WHERE id < 10", 10);
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.affectedRows, 10);
});

test('cellLiteral round-trips grid values through UPDATE', async () => {
  const [r] = await executeStatement(conn, 'SELECT id, name, data, price, meta FROM items ORDER BY id LIMIT 3', 10);
  for (const row of r.rows) {
    const set = r.columns.slice(1).map((c, i) => `\`${c.name}\` = ${cellLiteral(row[i + 1], c)}`).join(', ');
    await runQuery(conn, `UPDATE items SET ${set} WHERE id = ${cellLiteral(row[0], r.columns[0])}`);
  }
  const [after] = await executeStatement(conn, 'SELECT id, name, data, price, meta FROM items ORDER BY id LIMIT 3', 10);
  assert.deepEqual(after.rows, r.rows);
});

/* ---------------------------- dump + restore ---------------------------- */

async function checksums(c: mysql.Connection, db: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of ['items', 'child', 'bulk']) {
    const rows = await runQuery<Record<string, unknown>[]>(c, `SELECT * FROM \`${db}\`.\`${t}\` ORDER BY 1`);
    out[t] = JSON.stringify(rows, (_, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v));
  }
  return out;
}

for (const ext of ['sql', 'sql.gz']) {
  test(`dump and re-import (${ext})`, async () => {
    const file = path.join(tmp, `dump.${ext}`);
    const dumpConn = await open(DB);
    const res = await dumpDatabase(
      dumpConn,
      {
        database: DB,
        tables: ['items', 'child', 'bulk', 'v_items'],
        structure: true,
        data: true,
        dropTables: true,
        createDatabase: false,
        views: true,
        routines: true,
        triggers: true,
        insertBytes: 64 * 1024,
        version: 'test',
      },
      file,
      () => undefined,
      () => false,
    ).finally(() => dumpConn.destroy());
    assert.equal(res.tables, 3);
    assert.equal(res.rows, TRICKY.length + 1 + 2 + 5000);
    if (ext === 'sql') {
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /DEFINER=/);
      assert.doesNotMatch(text.slice(text.indexOf('INSERT INTO `items`')).split('\n')[0], /name_len/, 'generated column values are not dumped');
      assert.ok((text.match(/INSERT INTO `bulk`/g) ?? []).length > 1, 'bulk data split into batches');
    }

    await resetDb(conn, RESTORE);
    const target = await open(RESTORE);
    try {
      const p = await importSqlFile(target, file, () => undefined, async (_sql, e) => {
        throw e;
      }, () => false);
      assert.equal(p.errors, 0);
      assert.deepEqual(await checksums(target, RESTORE), await checksums(conn, DB));
      const view = await runQuery<{ n: number }[]>(target, 'SELECT COUNT(*) n FROM v_items');
      assert.ok(Number(view[0].n) > 0);
      const fn = await runQuery<{ v: number }[]>(target, 'SELECT add_one(41) v');
      assert.equal(fn[0].v, 42);
      await runQuery(target, "INSERT INTO items (name) VALUES ('')");
      const trg = await runQuery<{ name: string }[]>(target, 'SELECT name FROM items ORDER BY id DESC LIMIT 1');
      assert.equal(trg[0].name, '(empty)', 'trigger restored');
    } finally {
      target.destroy();
    }
  });
}

test('dump: cancellation removes the partial file', async () => {
  const file = path.join(tmp, 'cancel.sql');
  let calls = 0;
  const dumpConn = await open(DB);
  await assert.rejects(
    dumpDatabase(dumpConn, { database: DB, tables: ['bulk'], structure: true, data: true, dropTables: true, createDatabase: false, views: false, routines: false, triggers: false, insertBytes: 1024, version: 't' }, file, () => undefined, () => ++calls > 100),
    /cancelled/,
  );
  assert.equal(fs.existsSync(file), false);
});

test('sql import: error callback can skip a failing statement', async () => {
  const file = path.join(tmp, 'bad.sql');
  fs.writeFileSync(file, `CREATE TABLE IF NOT EXISTS t1 (id INT);\nINSERT INTO nope VALUES (1);\nINSERT INTO t1 VALUES (1),(2);\n`);
  await resetDb(conn, RESTORE);
  const target = await open(RESTORE);
  try {
    const seen: string[] = [];
    const p = await importSqlFile(target, file, () => undefined, async (sql) => {
      seen.push(sql);
      return 'skip';
    }, () => false);
    assert.equal(p.errors, 1);
    assert.equal(p.statements, 2);
    assert.deepEqual(seen, ['INSERT INTO nope VALUES (1)']);
    const n = await runQuery<{ n: string }[]>(target, 'SELECT COUNT(*) n FROM t1');
    assert.equal(n[0].n, '2', 'COUNT(*) is BIGINT and comes back as a string');
  } finally {
    target.destroy();
  }
});

/* ---------------------------- exporters ---------------------------- */

async function exportTo(format: ExportFormat, sql: string, table: string): Promise<string> {
  const file = path.join(tmp, `export.${format}`);
  const c = await open(DB);
  try {
    const s = streamQuery(c, sql);
    const w = createWriter(format, file, table);
    await w.begin(await s.columns);
    for await (const r of s.rows) await w.row(r.map(exportCell));
    await w.end();
  } finally {
    c.destroy();
  }
  return file;
}

test('export: SQL INSERT output re-imports identically', async () => {
  const file = await exportTo('sql', 'SELECT id, name, price, qty, note, meta, data, uid, created, day, kind, tags FROM items ORDER BY id', 'items');
  await resetDb(conn, RESTORE);
  const target = await open(RESTORE);
  try {
    await runQuery(target, `CREATE TABLE items LIKE ${DB}.items`);
    await runQuery(target, `DROP TRIGGER IF EXISTS trg_items`);
    const p = await importSqlFile(target, file, () => undefined, async (_s, e) => {
      throw e;
    }, () => false);
    assert.equal(p.errors, 0);
    const cols = 'id, name, price, qty, note, meta, data, uid, created, day, kind, tags';
    const a = await runQuery(conn, `SELECT ${cols} FROM ${DB}.items ORDER BY id`);
    const b = await runQuery(target, `SELECT ${cols} FROM items ORDER BY id`);
    assert.deepEqual(b, a);
  } finally {
    target.destroy();
  }
});

test('export: CSV, JSON, Markdown and XLSX are well formed', async () => {
  const csv = fs.readFileSync(await exportTo('csv', 'SELECT id, name, note FROM items ORDER BY id', 'items'), 'utf8');
  assert.ok(csv.startsWith('﻿id,name,note\r\n'));
  assert.match(csv, /"line1\nline2\r\nline3"/);

  const json = JSON.parse(fs.readFileSync(await exportTo('json', 'SELECT id, name, qty FROM items ORDER BY id', 'items'), 'utf8'));
  assert.equal(json.length, TRICKY.length + 1);
  assert.equal(json[0].id, 1);
  assert.equal(json[0].qty, '9007199254740993', 'unsafe integers stay strings');

  const md = fs.readFileSync(await exportTo('markdown', 'SELECT id, name FROM items ORDER BY id LIMIT 2', 'items'), 'utf8');
  assert.match(md, /^\| id \| name \|\n\| ---: \| --- \|/);

  const xlsx = await exportTo('xlsx', 'SELECT id, name, price FROM items ORDER BY id', 'items');
  assert.ok(fs.statSync(xlsx).size > 1000);
});

/* ---------------------------- data import ---------------------------- */

test('inferType', () => {
  assert.equal(inferType(['1', '2', '300']), 'INT');
  assert.equal(inferType(['1', '99999999999']), 'BIGINT');
  assert.equal(inferType(['007']), 'VARCHAR(100)', 'leading zeros stay text');
  assert.equal(inferType(['1.50', '22.125']), 'DECIMAL(12,3)');
  assert.equal(inferType(['2025-01-02', null]), 'DATE');
  assert.equal(inferType(['2025-01-02 10:11:12', '2025-01-02T10:11']), 'DATETIME');
  assert.equal(inferType(['x'.repeat(600)]), 'TEXT');
});

function plan(p: Partial<ImportPlan>): ImportPlan {
  return { createTable: false, table: '', newColumns: [], mapping: [], mode: 'insert', truncateFirst: false, emptyAsNull: true, batchSize: 2, ...p };
}

test('import CSV into a new table (semicolon, quotes, newlines, latin1 detection off)', async () => {
  const file = path.join(tmp, 'people.csv');
  fs.writeFileSync(file, 'Full Name;Age;Joined;Note\n"Ali; Valiyev";30;2024-01-02;"multi\nline ""quoted"""\nOʻlmas;;2024-02-03;\n');
  const o = await detectOptions(file);
  assert.equal(o.delimiter, ';');
  const pv = await preview(file, o);
  assert.deepEqual(pv.sourceColumns, ['Full Name', 'Age', 'Joined', 'Note']);
  assert.equal(pv.rows.length, 2);
  assert.deepEqual(pv.inferredTypes.slice(1, 3), ['INT', 'DATE']);
  await resetDb(conn, RESTORE);
  const target = await open(RESTORE);
  try {
    const n = await runDataImport(target, RESTORE, file, o, plan({
      createTable: true,
      table: 'people',
      newColumns: [
        { name: 'full_name', type: 'VARCHAR(100)', source: 0 },
        { name: 'age', type: 'INT', source: 1 },
        { name: 'joined', type: 'DATE', source: 2 },
        { name: 'note', type: 'TEXT', source: 3 },
      ],
    }), () => undefined, () => false);
    assert.equal(n, 2);
    const rows = await runQuery<Record<string, unknown>[]>(target, 'SELECT * FROM people ORDER BY joined');
    assert.deepEqual(rows, [
      { full_name: 'Ali; Valiyev', age: 30, joined: '2024-01-02', note: 'multi\nline "quoted"' },
      { full_name: 'Oʻlmas', age: null, joined: '2024-02-03', note: null },
    ]);
  } finally {
    target.destroy();
  }
});

test('import JSON into an existing table with mapping, REPLACE and rollback on failure', async () => {
  const file = path.join(tmp, 'rows.json');
  fs.writeFileSync(file, JSON.stringify([{ ID: 1, value: 'one' }, { ID: 2, value: 'two', extra: true }]));
  await resetDb(conn, RESTORE);
  const target = await open(RESTORE);
  try {
    await runQuery(target, 'CREATE TABLE kv (id INT PRIMARY KEY, v VARCHAR(10) NOT NULL)');
    await runQuery(target, "INSERT INTO kv VALUES (1, 'old'), (9, 'keep')");
    const o = await detectOptions(file);
    const pv = await preview(file, o);
    assert.deepEqual(pv.sourceColumns, ['ID', 'value', 'extra']);
    await runDataImport(target, RESTORE, file, o, plan({ table: 'kv', mode: 'replace', mapping: [{ column: 'id', source: 0 }, { column: 'v', source: 1 }] }), () => undefined, () => false);
    assert.deepEqual(await runQuery(target, 'SELECT * FROM kv ORDER BY id'), [{ id: 1, v: 'one' }, { id: 2, v: 'two' }, { id: 9, v: 'keep' }]);

    // Too-long value fails (strict mode) -> everything rolled back, including the DELETE.
    fs.writeFileSync(file, JSON.stringify([{ ID: 5, value: 'ok' }, { ID: 6, value: 'this value is far too long' }]));
    await assert.rejects(runDataImport(target, RESTORE, file, o, plan({ table: 'kv', truncateFirst: true, batchSize: 1, mapping: [{ column: 'id', source: 0 }, { column: 'v', source: 1 }] }), () => undefined, () => false));
    assert.deepEqual(await runQuery(target, 'SELECT * FROM kv ORDER BY id'), [{ id: 1, v: 'one' }, { id: 2, v: 'two' }, { id: 9, v: 'keep' }]);
  } finally {
    target.destroy();
  }
});

test('import XLSX produced by the exporter', async () => {
  const xlsx = await exportTo('xlsx', 'SELECT id, name, price, day FROM items WHERE price IS NOT NULL ORDER BY id', 'items');
  const o = await detectOptions(xlsx);
  const pv = await preview(xlsx, o);
  assert.deepEqual(pv.sourceColumns, ['id', 'name', 'price', 'day']);
  await resetDb(conn, RESTORE);
  const target = await open(RESTORE);
  try {
    const n = await runDataImport(target, RESTORE, xlsx, o, plan({
      createTable: true,
      table: 'from_xlsx',
      newColumns: pv.sourceColumns.map((name, i) => ({ name, type: i === 1 ? 'VARCHAR(200)' : pv.inferredTypes[i], source: i })),
    }), () => undefined, () => false);
    assert.equal(n, TRICKY.length);
    const a = await runQuery<Record<string, unknown>[]>(conn, `SELECT id, name, CAST(price AS DOUBLE) p FROM ${DB}.items WHERE price IS NOT NULL ORDER BY id`);
    const b = await runQuery<Record<string, unknown>[]>(target, 'SELECT id, name, CAST(price AS DOUBLE) p FROM from_xlsx ORDER BY id');
    // Excel stores line breaks as \n and drops empty strings; everything else must match.
    const expected = a.map((r) => ({ ...r, name: r.name === '' ? null : String(r.name).replace(/\r\n/g, '\n') }));
    assert.deepEqual(b, expected);
  } finally {
    target.destroy();
  }
});

