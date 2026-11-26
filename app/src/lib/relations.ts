import type { Cell, Column, ForeignKey } from './types';
import { sqlName } from './tableQuery';

/** MySQL string literal, escaped like the backend's `quote_str`. */
export function quoteStr(s: string): string {
  const map: Record<string, string> = { '\0': '\\0', '\n': '\\n', '\r': '\\r', '\\': '\\\\', "'": "\\'", '"': '\\"', '\x1a': '\\Z' };
  return `'${s.replace(/[\0\n\r\\'"\x1a]/g, (c) => map[c])}'`;
}

/** SQL literal for a grid value, typed like the backend's `cell_literal`. */
export function sqlLiteral(v: Cell, col?: Column): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (col?.binary && /^0x[0-9a-f]*$/i.test(v)) return v.length === 2 ? "''" : `X'${v.slice(2)}'`;
  if (col?.numeric && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return quoteStr(v);
}

/** Where a foreign key leads from one row: the table to open and its filter. */
export interface RelationTarget {
  db: string;
  table: string;
  filter: string;
}

/**
 * `a = 1 AND b = 'x'`, or null when a value is NULL or unknown (a NULL foreign
 * key references nothing, and `= NULL` would match nothing anyway).
 */
function matchFilter(names: string[], values: (Cell | undefined)[], cols: (Column | undefined)[]): string | null {
  if (!names.length || values.some((v) => v === null || v === undefined)) return null;
  return names.map((n, i) => `${sqlName(n)} = ${sqlLiteral(values[i] as Cell, cols[i])}`).join(' AND ');
}

/** The first foreign key of this table that includes `column`. */
export function foreignKeyOf(outgoing: ForeignKey[], column: string): ForeignKey | undefined {
  return outgoing.find((fk) => fk.columns.includes(column));
}

/** The referenced row of `fk`, given the current row's values by column name. */
export function outgoingTarget(fk: ForeignKey, columns: Column[], row: (name: string) => Cell | undefined): RelationTarget | null {
  const cols = fk.columns.map((c) => columns.find((x) => x.name === c));
  const filter = matchFilter(fk.refColumns, fk.columns.map(row), cols);
  return filter ? { db: fk.refDb, table: fk.refTable, filter } : null;
}

/** The rows of `fk.table` that point at the current row. */
export function incomingTarget(fk: ForeignKey, columns: Column[], row: (name: string) => Cell | undefined): RelationTarget | null {
  const cols = fk.refColumns.map((c) => columns.find((x) => x.name === c));
  const filter = matchFilter(fk.columns, fk.refColumns.map(row), cols);
  return filter ? { db: fk.db, table: fk.table, filter } : null;
}

/** "customers.id" or "shop.customers (id, shop_id)" for menus and tooltips. */
export function describeTarget(fk: ForeignKey, fromDb: string): string {
  const t = fk.refDb === fromDb ? fk.refTable : `${fk.refDb}.${fk.refTable}`;
  return fk.refColumns.length === 1 ? `${t}.${fk.refColumns[0]}` : `${t} (${fk.refColumns.join(', ')})`;
}

/* ----------------------------- binary values ----------------------------- */

export const isJsonColumn = (c: Column) => /^json\b/i.test(c.type);
export const isBinaryColumn = (c: Column) => !!c.binary || /blob|binary|^bit\b/i.test(c.type);

/** "(binary 52341 bytes)": the backend sends this instead of hex for large values. */
const TRUNCATED = /^\(binary (\d+) bytes\)$/;

/** Byte length of a hex or truncated binary cell, or null if it is neither. */
export function binaryLength(v: Cell): number | null {
  if (typeof v !== 'string') return null;
  const t = TRUNCATED.exec(v);
  if (t) return Number(t[1]);
  return /^0x[0-9a-f]*$/i.test(v) && v.length % 2 === 0 ? (v.length - 2) / 2 : null;
}

export const isTruncatedBinary = (v: Cell) => typeof v === 'string' && TRUNCATED.test(v);

const SIGNATURES: [string, string, string][] = [
  ['89504E470D0A1A0A', 'image/png', 'PNG'],
  ['FFD8FF', 'image/jpeg', 'JPEG'],
  ['474946383', 'image/gif', 'GIF'],
  ['424D', 'image/bmp', 'BMP'],
  ['00000100', 'image/x-icon', 'ICO'],
  ['25504446', 'application/pdf', 'PDF'],
  ['504B0304', 'application/zip', 'ZIP'],
  ['1F8B', 'application/gzip', 'GZIP'],
];

/** File type from the first bytes (hex, without 0x). WEBP needs bytes 8–11 as well. */
export function sniff(hexBody: string): { mime: string; label: string } | null {
  const h = hexBody.slice(0, 32).toUpperCase();
  if (h.startsWith('52494646') && h.slice(16, 24) === '57454250') return { mime: 'image/webp', label: 'WEBP' };
  const s = SIGNATURES.find(([sig]) => h.startsWith(sig));
  return s ? { mime: s[1], label: s[2] } : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Short grid text for a binary cell: "PNG image · 740 B" or "0x0A1B… · 16 B". */
export function binarySummary(v: Cell): string | null {
  const len = binaryLength(v);
  if (len === null || typeof v !== 'string') return null;
  if (isTruncatedBinary(v)) return `binary · ${formatBytes(len)}`;
  const kind = sniff(v.slice(2));
  if (kind) return `${kind.label}${kind.mime.startsWith('image/') ? ' image' : ''} · ${formatBytes(len)}`;
  return len <= 32 ? v : `${v.slice(0, 26)}… · ${formatBytes(len)}`;
}
