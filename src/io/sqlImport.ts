import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import * as mysql from 'mysql2';
import { runQuery } from '../connections/driver';
import { SqlSplitter } from '../query/splitter';

export interface SqlImportProgress {
  bytesRead: number;
  totalBytes: number;
  statements: number;
  errors: number;
}

export type OnStatementError = (sql: string, error: Error) => Promise<'stop' | 'skip' | 'skipAll'>;

/**
 * Streams a .sql (or .sql.gz) file and runs it statement by statement on one
 * connection, so SET/USE/DELIMITER from the file keep working.
 */
export async function importSqlFile(
  conn: mysql.Connection,
  path: string,
  onProgress: (p: SqlImportProgress) => void,
  onError: OnStatementError,
  isCancelled: () => boolean,
): Promise<SqlImportProgress> {
  const totalBytes = (await fs.promises.stat(path)).size;
  const raw = fs.createReadStream(path, { highWaterMark: 256 * 1024 });
  let bytesRead = 0;
  raw.on('data', (c) => (bytesRead += c.length));
  const source: AsyncIterable<Buffer> = path.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;

  const decoder = new StringDecoder('utf8');
  const splitter = new SqlSplitter();
  const p: SqlImportProgress = { bytesRead: 0, totalBytes, statements: 0, errors: 0 };
  let skipAll = false;
  let first = true;
  let lastReport = 0;

  const runAll = async (stmts: { sql: string }[]) => {
    for (const st of stmts) {
      if (isCancelled()) {
        throw new Error('cancelled');
      }
      try {
        await runQuery(conn, st.sql);
        p.statements++;
      } catch (e) {
        p.errors++;
        if (skipAll) {
          continue;
        }
        const choice = await onError(st.sql, e as Error);
        if (choice === 'stop') {
          throw e;
        }
        if (choice === 'skipAll') {
          skipAll = true;
        }
      }
      const now = Date.now();
      if (now - lastReport > 200) {
        lastReport = now;
        p.bytesRead = bytesRead;
        onProgress({ ...p });
      }
    }
  };

  try {
    for await (const chunk of source) {
      let text = decoder.write(chunk);
      if (first) {
        text = text.replace(/^﻿/, '');
        first = false;
      }
      // Pause reading while statements run; for-await gives back-pressure.
      await runAll(splitter.push(text));
    }
    await runAll(splitter.push(decoder.end()));
    await runAll(splitter.end());
  } finally {
    raw.destroy();
  }
  p.bytesRead = totalBytes;
  onProgress({ ...p });
  return p;
}
