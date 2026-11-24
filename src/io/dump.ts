import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as mysql from 'mysql2';
import { runQuery } from '../connections/driver';
import { qid, rawLiteral, NUMERIC_TYPES } from '../sql';

export interface DumpOptions {
  database: string;
  tables: string[];
  structure: boolean;
  data: boolean;
  dropTables: boolean;
  createDatabase: boolean;
  views: boolean;
  routines: boolean;
  triggers: boolean;
  /** Maximum size of one extended INSERT statement in bytes. */
  insertBytes: number;
  version: string;
}

export interface DumpProgress {
  table: string;
  tableIndex: number;
  tableCount: number;
  rows: number;
}

class Out {
  private readonly file: fs.WriteStream;
  private readonly sink: NodeJS.WritableStream;
  private readonly gz?: zlib.Gzip;

  constructor(path: string) {
    this.file = fs.createWriteStream(path);
    if (path.endsWith('.gz')) {
      this.gz = zlib.createGzip();
      this.gz.pipe(this.file);
      this.sink = this.gz;
    } else {
      this.sink = this.file;
    }
  }

  write(s: string): Promise<void> | void {
    if (!this.sink.write(s)) {
      return new Promise((r) => this.sink.once('drain', () => r()));
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.file.once('finish', resolve);
      this.file.once('error', reject);
      this.sink.end();
    });
  }

  destroy(): void {
    // Pending writes fail once destroyed; the file is deleted anyway.
    const ignore = () => undefined;
    this.gz?.on('error', ignore).destroy();
    this.file.on('error', ignore).destroy();
  }
}

/** Removes `DEFINER=...` so the dump imports under any account. */
function stripDefiner(sql: string): string {
  return sql.replace(/\sDEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)/i, '');
}

function header(o: DumpOptions): string {
  return `-- MySQL Lens dump
-- Server version: ${o.version}
-- Database: ${o.database}
-- Generated: ${new Date().toISOString()}

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

`;
}

const FOOTER = `
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;
/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed
`;

/**
 * Writes a mysqldump-compatible SQL file. The connection must be dedicated:
 * the time zone is switched to UTC so TIMESTAMP values round-trip, and it is
 * closed if the dump is cancelled while streaming rows.
 */
export async function dumpDatabase(
  conn: mysql.Connection,
  o: DumpOptions,
  path: string,
  onProgress: (p: DumpProgress) => void,
  isCancelled: () => boolean,
): Promise<{ tables: number; rows: number }> {
  const out = new Out(path);
  let totalRows = 0;
  try {
    await runQuery(conn, "SET SESSION time_zone = '+00:00'");
    await out.write(header(o));
    if (o.createDatabase) {
      const rows = await runQuery<Record<string, string>[]>(conn, `SHOW CREATE DATABASE ${qid(o.database)}`);
      const create = (rows[0]?.['Create Database'] ?? `CREATE DATABASE ${qid(o.database)}`).replace(/^CREATE DATABASE /i, 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ ');
      await out.write(`${create};\nUSE ${qid(o.database)};\n\n`);
    }

    const kinds = await runQuery<{ name: string; type: string }[]>(
      conn,
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [o.database],
    );
    const isView = new Map(kinds.map((k) => [k.name, k.type.includes('VIEW')]));
    const baseTables = o.tables.filter((t) => !isView.get(t));
    const views = o.views ? o.tables.filter((t) => isView.get(t)) : [];

    for (let i = 0; i < baseTables.length; i++) {
      if (isCancelled()) {
        throw new Error('cancelled');
      }
      const t = baseTables[i];
      const ft = `${qid(o.database)}.${qid(t)}`;
      onProgress({ table: t, tableIndex: i, tableCount: baseTables.length, rows: 0 });
      if (o.structure) {
        const rows = await runQuery<Record<string, string>[]>(conn, `SHOW CREATE TABLE ${ft}`);
        await out.write(`--\n-- Table structure for ${qid(t)}\n--\n\n`);
        if (o.dropTables) {
          await out.write(`DROP TABLE IF EXISTS ${qid(t)};\n`);
        }
        await out.write(`${rows[0]['Create Table']};\n\n`);
      }
      if (o.data) {
        totalRows += await dumpTableData(conn, out, o, t, (n) => onProgress({ table: t, tableIndex: i, tableCount: baseTables.length, rows: n }), isCancelled);
      }
    }

    // Views go after all tables; a temporary stub is not needed because
    // tables already exist at this point.
    for (const v of views) {
      const rows = await runQuery<Record<string, string>[]>(conn, `SHOW CREATE VIEW ${qid(o.database)}.${qid(v)}`);
      await out.write(`--\n-- View ${qid(v)}\n--\n\n`);
      if (o.dropTables) {
        await out.write(`DROP VIEW IF EXISTS ${qid(v)};\n`);
      }
      await out.write(`${stripDefiner(rows[0]['Create View'])};\n\n`);
    }

    if (o.routines) {
      const routines = await runQuery<{ name: string; type: string }[]>(
        conn,
        'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME',
        [o.database],
      );
      for (const r of routines) {
        const rows = await runQuery<Record<string, string | null>[]>(conn, `SHOW CREATE ${r.type} ${qid(o.database)}.${qid(r.name)}`);
        const body = rows[0]?.[r.type === 'FUNCTION' ? 'Create Function' : 'Create Procedure'];
        if (!body) {
          await out.write(`-- Skipped ${r.type.toLowerCase()} ${qid(r.name)}: no permission to read its body\n\n`);
          continue;
        }
        await out.write(`--\n-- ${r.type === 'FUNCTION' ? 'Function' : 'Procedure'} ${qid(r.name)}\n--\n\n`);
        if (o.dropTables) {
          await out.write(`DROP ${r.type} IF EXISTS ${qid(r.name)};\n`);
        }
        await out.write(`DELIMITER ;;\n${stripDefiner(body)} ;;\nDELIMITER ;\n\n`);
      }
    }

    if (o.triggers) {
      const triggers = await runQuery<{ name: string; tbl: string }[]>(
        conn,
        'SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
        [o.database],
      );
      for (const tr of triggers.filter((x) => o.tables.includes(x.tbl))) {
        const rows = await runQuery<Record<string, string>[]>(conn, `SHOW CREATE TRIGGER ${qid(o.database)}.${qid(tr.name)}`);
        await out.write(`--\n-- Trigger ${qid(tr.name)}\n--\n\n`);
        if (o.dropTables) {
          await out.write(`DROP TRIGGER IF EXISTS ${qid(tr.name)};\n`);
        }
        await out.write(`DELIMITER ;;\n${stripDefiner(rows[0]['SQL Original Statement'])} ;;\nDELIMITER ;\n\n`);
      }
    }

    await out.write(FOOTER);
    await out.close();
    return { tables: baseTables.length, rows: totalRows };
  } catch (e) {
    out.destroy();
    await fs.promises.rm(path, { force: true });
    throw e;
  }
}

async function dumpTableData(
  conn: mysql.Connection,
  out: Out,
  o: DumpOptions,
  table: string,
  onRows: (n: number) => void,
  isCancelled: () => boolean,
): Promise<number> {
  // Generated columns cannot be inserted; list the real ones explicitly.
  const cols = await runQuery<{ name: string; type: string; extra: string }[]>(
    conn,
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, EXTRA AS extra FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [o.database, table],
  );
  const real = cols.filter((c) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(c.extra));
  if (!real.length) {
    return 0;
  }
  const numeric = real.map((c) => NUMERIC_TYPES.has(c.type.toUpperCase()) || /^(decimal|float|double)$/i.test(c.type));
  const colList = real.map((c) => qid(c.name)).join(', ');
  const head = `INSERT INTO ${qid(table)} (${colList}) VALUES `;
  const select = `SELECT ${colList} FROM ${qid(o.database)}.${qid(table)}`;

  let rows = 0;
  let batch: string[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length) {
      await out.write(head + batch.join(',') + ';\n');
      batch = [];
      batchBytes = 0;
    }
  };

  await out.write(`--\n-- Data for ${qid(table)}\n--\n\n/*!40000 ALTER TABLE ${qid(table)} DISABLE KEYS */;\n`);
  const q = conn.query({ sql: select, rowsAsArray: true });
  const stream = q.stream({ objectMode: true, highWaterMark: 1000 });
  for await (const row of stream as AsyncIterable<unknown[]>) {
    if (isCancelled()) {
      // The server keeps sending rows; closing the connection is the only clean stop.
      conn.destroy();
      throw new Error('cancelled');
    }
    const tuple = '(' + row.map((v, i) => rawLiteral(v, numeric[i])).join(',') + ')';
    batch.push(tuple);
    batchBytes += tuple.length + 1;
    rows++;
    if (batchBytes >= o.insertBytes) {
      await flush();
    }
    if (rows % 2000 === 0) {
      onRows(rows);
    }
  }
  await flush();
  await out.write(`/*!40000 ALTER TABLE ${qid(table)} ENABLE KEYS */;\n\n`);
  onRows(rows);
  return rows;
}
