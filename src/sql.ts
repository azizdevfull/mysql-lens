import * as mysql from 'mysql2';
import type { Cell, ColumnInfo } from './shared/protocol';

export const NUMERIC_TYPES = new Set([
  'DECIMAL', 'NEWDECIMAL', 'TINY', 'SHORT', 'LONG', 'FLOAT', 'DOUBLE', 'LONGLONG', 'INT24', 'YEAR',
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT',
]);

export function qid(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

export function qualified(db: string, name: string): string {
  return `${qid(db)}.${qid(name)}`;
}

export function literal(v: unknown): string {
  return mysql.escape(v as mysql.SqlValue);
}

/** Inline-display limit for binary values; larger values are shown as a size tag. */
const BINARY_INLINE_BYTES = 1024;

/** Converts a raw driver value into something the grid can show. */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    return v;
  }
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (Buffer.isBuffer(v)) {
    return v.length <= BINARY_INLINE_BYTES ? '0x' + v.toString('hex').toUpperCase() : `(binary ${formatBytes(v.length)})`;
  }
  if (v instanceof Date) {
    return v.toISOString();
  }
  if (typeof v === 'object') {
    return JSON.stringify(v);
  }
  return String(v);
}

/** SQL literal for a value coming back from the grid. */
export function cellLiteral(v: Cell, col: ColumnInfo | undefined): string {
  if (v === null) {
    return 'NULL';
  }
  if (col?.binary && typeof v === 'string' && /^0x[0-9a-f]*$/i.test(v)) {
    return v.length === 2 ? "''" : `X'${v.slice(2)}'`;
  }
  if (col?.numeric && typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) {
    return v.trim();
  }
  return mysql.escape(v);
}

/** SQL literal for a raw driver value (used by the dump writer). */
export function rawLiteral(v: unknown, numeric: boolean): string {
  if (v === null || v === undefined) {
    return 'NULL';
  }
  if (Buffer.isBuffer(v)) {
    return v.length === 0 ? "''" : `0x${v.toString('hex')}`;
  }
  if (numeric && (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)))) {
    return String(v);
  }
  return mysql.escape((typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v) as mysql.SqlValue);
}

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatCount(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Column metadata from a driver field packet. */
export function columnFromField(f: mysql.FieldPacket): ColumnInfo {
  const codeNum = f.columnType ?? f.type;
  const code = typeof codeNum === 'number' ? String((mysql.Types as unknown as Record<number, string>)[codeNum] ?? codeNum) : String(f.typeName ?? '');
  const flags = typeof f.flags === 'number' ? f.flags : 0;
  const binaryCharset = (f.characterSet ?? f.charsetNr) === 63;
  return {
    name: f.name,
    type: prettyType(code, flags, binaryCharset),
    table: f.orgTable || f.table || undefined,
    pk: (flags & 2) !== 0,
    nullable: (flags & 1) === 0,
    autoIncrement: (flags & 512) !== 0,
    numeric: NUMERIC_TYPES.has(code),
    binary: binaryCharset && /BLOB|STRING|BIT|GEOMETRY/.test(code),
  };
}

function prettyType(code: string, flags: number, binaryCharset: boolean): string {
  switch (code) {
    case 'TINY': return 'TINYINT';
    case 'SHORT': return 'SMALLINT';
    case 'LONG': return 'INT';
    case 'INT24': return 'MEDIUMINT';
    case 'LONGLONG': return 'BIGINT';
    case 'NEWDECIMAL': return 'DECIMAL';
    case 'VAR_STRING': return binaryCharset ? 'VARBINARY' : 'VARCHAR';
    case 'STRING': {
      if (flags & 256) { return 'ENUM'; }
      if (flags & 2048) { return 'SET'; }
      return binaryCharset ? 'BINARY' : 'CHAR';
    }
    case 'BLOB':
    case 'TINY_BLOB':
    case 'MEDIUM_BLOB':
    case 'LONG_BLOB':
      return binaryCharset ? 'BLOB' : 'TEXT';
    default:
      return code;
  }
}
