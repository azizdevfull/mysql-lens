import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadExcel } from './exporters';
import * as mysql from 'mysql2';
import { runQuery } from '../connections/driver';
import type { Cell, ImportPlan, ImportPreview, ImportSourceOptions } from '../shared/protocol';
import { literal, qid, qualified } from '../sql';

const PREVIEW_ROWS = 200;

export function fileKind(file: string): ImportPreview['fileKind'] {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') {
    return 'json';
  }
  if (ext === '.xlsx' || ext === '.xlsm') {
    return 'xlsx';
  }
  return 'csv';
}

export async function detectOptions(file: string): Promise<ImportSourceOptions> {
  const opts: ImportSourceOptions = { delimiter: ',', header: true, quote: '"', encoding: 'utf8' };
  if (fileKind(file) !== 'csv') {
    return opts;
  }
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split(/\r?\n/).slice(0, 10).filter(Boolean);
    let best = ',';
    let bestScore = -1;
    for (const d of [',', ';', '\t', '|']) {
      const counts = lines.map((l) => l.split(d).length - 1);
      const consistent = counts.length > 0 && counts.every((c) => c === counts[0]);
      const score = (counts[0] ?? 0) * (consistent ? 2 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    opts.delimiter = best;
    if (file.toLowerCase().endsWith('.tsv')) {
      opts.delimiter = '\t';
    }
    // Invalid UTF-8 shows up as U+FFFD; fall back to Windows-1252-ish latin1.
    if (text.includes('�')) {
      opts.encoding = 'latin1';
    }
  } finally {
    await fd.close();
  }
  return opts;
}

async function csvParser(file: string, o: ImportSourceOptions, toLine?: number) {
  const { parse } = await import('csv-parse');
  return fs.createReadStream(file, { encoding: o.encoding as BufferEncoding }).pipe(
    parse({
      delimiter: o.delimiter === '\\t' ? '\t' : o.delimiter || ',',
      quote: o.quote || '"',
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      to_line: toLine,
    }),
  );
}

function normalize(v: unknown): Cell {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    return v;
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }
  if (v instanceof Date) {
    return v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) {
      return normalize(o.result);
    }
    if (Array.isArray(o.richText)) {
      return (o.richText as { text: string }[]).map((t) => t.text).join('');
    }
    if ('text' in o) {
      return normalize(o.text);
    }
    if ('error' in o) {
      return null;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

interface Loaded {
  columns: string[];
  rows: AsyncIterable<Cell[]>;
  sheets?: string[];
  count?: number;
}

/** Opens a source file and yields its data rows (header excluded). */
async function load(file: string, o: ImportSourceOptions, previewOnly: boolean): Promise<Loaded> {
  const kind = fileKind(file);
  if (kind === 'csv') {
    const first = await firstRecord(file, o);
    const columns = o.header ? first.map((c, i) => String(c ?? '').trim() || `column_${i + 1}`) : first.map((_, i) => `column_${i + 1}`);
    const parser = await csvParser(file, o, previewOnly ? PREVIEW_ROWS + 1 : undefined);
    async function* rows(): AsyncIterable<Cell[]> {
      let skip = o.header;
      for await (const rec of parser as AsyncIterable<string[]>) {
        if (skip) {
          skip = false;
          continue;
        }
        yield rec;
      }
    }
    return { columns, rows: rows() };
  }
  if (kind === 'json') {
    const text = (await fs.promises.readFile(file, o.encoding as BufferEncoding)).replace(/^﻿/, '');
    let data: unknown;
    const trimmed = text.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        data = JSON.parse(trimmed);
      } catch {
        data = undefined;
      }
    }
    if (data === undefined) {
      // JSON Lines
      data = trimmed.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    }
    if (!Array.isArray(data)) {
      // { "rows": [...] } or similar: take the first array property.
      const arr = Object.values(data as Record<string, unknown>).find(Array.isArray);
      if (!arr) {
        throw new Error('JSON must be an array of objects (or arrays).');
      }
      data = arr;
    }
    const list = data as unknown[];
    let columns: string[];
    let toRow: (x: unknown) => Cell[];
    if (list.length && Array.isArray(list[0])) {
      const width = Math.max(...list.slice(0, 1000).map((r) => (r as unknown[]).length));
      columns = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
      toRow = (x) => (x as unknown[]).map(normalize);
    } else {
      const keys = new Set<string>();
      for (const r of list.slice(0, 1000)) {
        Object.keys((r ?? {}) as object).forEach((k) => keys.add(k));
      }
      columns = [...keys];
      toRow = (x) => columns.map((k) => normalize((x as Record<string, unknown>)?.[k]));
    }
    const slice = previewOnly ? list.slice(0, PREVIEW_ROWS) : list;
    async function* rows(): AsyncIterable<Cell[]> {
      for (const r of slice) {
        yield toRow(r);
      }
    }
    return { columns, rows: rows(), count: list.length };
  }
  // xlsx
  const Excel = await loadExcel();
  const wb = new Excel.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = wb.worksheets.map((w) => w.name);
  const ws = (o.sheet && wb.getWorksheet(o.sheet)) || wb.worksheets[0];
  if (!ws) {
    throw new Error('The workbook has no sheets.');
  }
  const all: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1);
    all.push(values.map(normalize));
  });
  const width = Math.max(0, ...all.map((r) => r.length));
  const pad = (r: Cell[]) => (r.length < width ? [...r, ...Array(width - r.length).fill(null)] : r);
  const headerRow = o.header ? all.shift() ?? [] : [];
  const columns = Array.from({ length: width }, (_, i) => String(headerRow[i] ?? '').trim() || `column_${i + 1}`);
  const body = previewOnly ? all.slice(0, PREVIEW_ROWS) : all;
  async function* rows(): AsyncIterable<Cell[]> {
    for (const r of body) {
      yield pad(r);
    }
  }
  return { columns, rows: rows(), sheets, count: all.length };
}

async function firstRecord(file: string, o: ImportSourceOptions): Promise<string[]> {
  for await (const rec of (await csvParser(file, o, 1)) as AsyncIterable<string[]>) {
    return rec;
  }
  return [];
}

export async function preview(file: string, o: ImportSourceOptions): Promise<ImportPreview> {
  const l = await load(file, o, true);
  const rows: Cell[][] = [];
  for await (const r of l.rows) {
    rows.push(r);
  }
  const stat = await fs.promises.stat(file);
  return {
    fileName: path.basename(file),
    fileKind: fileKind(file),
    sourceColumns: l.columns,
    rows,
    rowCountHint: l.count !== undefined ? `${l.count.toLocaleString()} rows` : `${(stat.size / 1024 / 1024).toFixed(1)} MB`,
    sheets: l.sheets,
    options: o,
    inferredTypes: l.columns.map((_, i) => inferType(rows.map((r) => r[i]))),
  };
}

export function inferType(values: Cell[]): string {
  const vals = values.filter((v) => v !== null && v !== '').map((v) => String(v).trim());
  if (!vals.length) {
    return 'VARCHAR(255)';
  }
  if (vals.every((v) => /^-?\d{1,18}$/.test(v) && !(v.length > 1 && v.startsWith('0')))) {
    const big = vals.some((v) => Math.abs(Number(v)) > 2147483647);
    return big ? 'BIGINT' : 'INT';
  }
  if (vals.every((v) => /^-?\d+\.\d+$/.test(v))) {
    const scale = Math.max(...vals.map((v) => v.split('.')[1].length));
    const intDigits = Math.max(...vals.map((v) => v.replace('-', '').split('.')[0].length));
    return scale <= 6 && intDigits + scale <= 30 ? `DECIMAL(${Math.max(intDigits + scale, 10) + 2},${scale})` : 'DOUBLE';
  }
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) {
    return 'DATE';
  }
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v))) {
    return 'DATETIME';
  }
  const maxLen = Math.max(...vals.map((v) => v.length));
  if (maxLen > 2000) {
    return 'LONGTEXT';
  }
  if (maxLen > 500) {
    return 'TEXT';
  }
  return `VARCHAR(${maxLen <= 50 ? 100 : maxLen <= 150 ? 255 : 1000})`;
}

/** Normalizes a value for a typed column, e.g. ISO dates for DATETIME. */
function prepare(v: Cell, emptyAsNull: boolean): Cell {
  if (v === null) {
    return null;
  }
  if (typeof v === 'string') {
    if (v === '' && emptyAsNull) {
      return null;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/.test(v)) {
      return v.replace('T', ' ').replace(/Z$/, '');
    }
  }
  return v;
}

export interface DataImportProgress {
  rows: number;
  message: string;
}

export async function runDataImport(
  conn: mysql.Connection,
  db: string,
  file: string,
  o: ImportSourceOptions,
  plan: ImportPlan,
  onProgress: (p: DataImportProgress) => void,
  isCancelled: () => boolean,
): Promise<number> {
  const target = qualified(db, plan.table);
  let targetCols: { name: string; source: number }[];
  if (plan.createTable) {
    if (!plan.newColumns.length) {
      throw new Error('Choose at least one column.');
    }
    const defs = plan.newColumns.map((c) => `  ${qid(c.name)} ${c.type}`).join(',\n');
    await runQuery(conn, `CREATE TABLE ${target} (\n${defs}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    targetCols = plan.newColumns.map((c) => ({ name: c.name, source: c.source }));
  } else {
    targetCols = plan.mapping.filter((m) => m.source >= 0).map((m) => ({ name: m.column, source: m.source }));
    if (!targetCols.length) {
      throw new Error('Map at least one source column to a table column.');
    }
  }

  const verb = plan.mode === 'replace' ? 'REPLACE' : plan.mode === 'ignore' ? 'INSERT IGNORE' : 'INSERT';
  const head = `${verb} INTO ${target} (${targetCols.map((c) => qid(c.name)).join(', ')}) VALUES `;
  const batchSize = Math.max(1, Math.min(5000, plan.batchSize || 500));

  const l = await load(file, o, false);
  let batch: string[] = [];
  let done = 0;
  const flush = async () => {
    if (!batch.length) {
      return;
    }
    await runQuery(conn, head + batch.join(','));
    done += batch.length;
    batch = [];
    onProgress({ rows: done, message: `${done.toLocaleString()} rows imported` });
  };

  await runQuery(conn, 'START TRANSACTION');
  try {
    // Inside the transaction so a failed import also restores the old rows.
    if (!plan.createTable && plan.truncateFirst) {
      onProgress({ rows: 0, message: 'Clearing table…' });
      await runQuery(conn, `DELETE FROM ${target}`);
    }
    for await (const r of l.rows) {
      if (isCancelled()) {
        throw new Error('cancelled');
      }
      batch.push('(' + targetCols.map((c) => literal(prepare(r[c.source] ?? null, plan.emptyAsNull))).join(',') + ')');
      if (batch.length >= batchSize) {
        await flush();
      }
    }
    await flush();
    await runQuery(conn, 'COMMIT');
  } catch (e) {
    await runQuery(conn, 'ROLLBACK').catch(() => undefined);
    if (plan.createTable) {
      await runQuery(conn, `DROP TABLE IF EXISTS ${target}`).catch(() => undefined);
    }
    throw e;
  }
  return done;
}
