import * as mysql from 'mysql2';
import type { ResultSet, Cell, ColumnInfo } from '../shared/protocol';
import { columnFromField, toCell } from '../sql';

let nextId = 1;

/**
 * Runs one statement on a connection and collects every result set it
 * produces (a CALL can return several). Rows beyond `maxRows` are counted but
 * not kept, so a huge SELECT cannot exhaust memory.
 */
export function executeStatement(conn: mysql.Connection, sql: string, maxRows: number): Promise<ResultSet[]> {
  return new Promise((resolve) => {
    const started = Date.now();
    const results: ResultSet[] = [];
    let current: ResultSet | undefined;

    const q = conn.query({ sql, rowsAsArray: true });
    q.on('fields', (fields: mysql.FieldPacket[] | undefined) => {
      // mysql2 also fires 'fields' (without fields) before the trailing OK packet of a CALL.
      if (!fields) {
        return;
      }
      current = {
        id: nextId++,
        sql,
        kind: 'rows',
        columns: fields.map(columnFromField),
        rows: [],
        totalRows: 0,
        truncated: false,
        durationMs: 0,
      };
      results.push(current);
    });
    q.on('result', (row: unknown) => {
      if (Array.isArray(row)) {
        if (!current) {
          return;
        }
        current.totalRows++;
        if (current.rows.length < maxRows) {
          current.rows.push(row.map(toCell));
        } else {
          current.truncated = true;
        }
        return;
      }
      const h = row as mysql.ResultSetHeader;
      results.push({
        id: nextId++,
        sql,
        kind: 'ok',
        columns: [],
        rows: [],
        totalRows: 0,
        truncated: false,
        affectedRows: h.affectedRows,
        insertId: h.insertId,
        info: h.info,
        warnings: h.warningStatus,
        durationMs: 0,
      });
      current = undefined;
    });
    q.on('error', (err: Error & { code?: string; sqlMessage?: string }) => {
      results.push({
        id: nextId++,
        sql,
        kind: 'error',
        columns: [],
        rows: [],
        totalRows: 0,
        truncated: false,
        error: err.code ? `${err.code}: ${err.sqlMessage ?? err.message}` : err.message,
        durationMs: 0,
      });
    });
    q.on('end', () => {
      const ms = Date.now() - started;
      // A CALL returns its result sets followed by an OK packet; hide that
      // trailing OK so the user sees only the rows.
      const filtered = results.length > 1 ? results.filter((r, i) => !(r.kind === 'ok' && i === results.length - 1 && results[i - 1].kind === 'rows')) : results;
      for (const r of filtered) {
        r.durationMs = ms;
      }
      resolve(filtered);
    });
  });
}

export function resultToObjects(columns: ColumnInfo[], rows: Cell[][]): Record<string, Cell>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]])));
}

/** Kills the running statement of `threadId` using another connection. */
export function killQuery(pool: mysql.Pool, threadId: number): Promise<void> {
  return new Promise((resolve) => {
    pool.query(`KILL QUERY ${Number(threadId)}`, () => resolve());
  });
}
