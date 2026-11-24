import * as fs from 'node:fs';
import * as path from 'node:path';
import * as mysql from 'mysql2';
import ExcelJS from 'exceljs';
import type { Cell, ColumnInfo, ExportFormat } from '../shared/protocol';
import { cellLiteral, columnFromField, qid } from '../sql';

export interface RowWriter {
  begin(columns: ColumnInfo[]): Promise<void>;
  row(values: Cell[]): Promise<void>;
  end(): Promise<void>;
  abort(): Promise<void>;
}

export const FORMAT_INFO: Record<ExportFormat, { label: string; ext: string; detail: string }> = {
  csv: { label: 'CSV', ext: 'csv', detail: 'Comma separated, UTF-8 with header row' },
  tsv: { label: 'TSV', ext: 'tsv', detail: 'Tab separated, opens directly in Excel' },
  xlsx: { label: 'Excel', ext: 'xlsx', detail: 'Excel workbook (.xlsx)' },
  json: { label: 'JSON', ext: 'json', detail: 'Array of objects' },
  sql: { label: 'SQL INSERT', ext: 'sql', detail: 'INSERT statements' },
  markdown: { label: 'Markdown', ext: 'md', detail: 'Markdown table' },
};

class TextFile {
  private readonly out: fs.WriteStream;

  constructor(readonly file: string) {
    this.out = fs.createWriteStream(file, { encoding: 'utf8' });
  }

  write(s: string): Promise<void> {
    if (this.out.write(s)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.out.once('drain', resolve);
      this.out.once('error', reject);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  async remove(): Promise<void> {
    this.out.on('error', () => undefined).destroy();
    await fs.promises.rm(this.file, { force: true });
  }
}

function csvField(v: Cell, sep: string): string {
  if (v === null) {
    return '';
  }
  const s = String(v);
  if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

class DelimitedWriter implements RowWriter {
  private readonly f: TextFile;
  constructor(file: string, private readonly sep: string) {
    this.f = new TextFile(file);
  }
  async begin(columns: ColumnInfo[]) {
    // BOM so Excel detects UTF-8.
    await this.f.write('﻿' + columns.map((c) => csvField(c.name, this.sep)).join(this.sep) + '\r\n');
  }
  row(values: Cell[]) {
    return this.f.write(values.map((v) => csvField(v, this.sep)).join(this.sep) + '\r\n');
  }
  end() {
    return this.f.close();
  }
  abort() {
    return this.f.remove();
  }
}

class JsonWriter implements RowWriter {
  private readonly f: TextFile;
  private cols: ColumnInfo[] = [];
  private first = true;
  constructor(file: string) {
    this.f = new TextFile(file);
  }
  async begin(columns: ColumnInfo[]) {
    this.cols = columns;
    await this.f.write('[');
  }
  row(values: Cell[]) {
    const obj: Record<string, unknown> = {};
    this.cols.forEach((c, i) => {
      const v = values[i];
      obj[c.name] = c.numeric && typeof v === 'string' && Number.isSafeInteger(Number(v)) ? Number(v) : v;
    });
    const s = (this.first ? '\n  ' : ',\n  ') + JSON.stringify(obj);
    this.first = false;
    return this.f.write(s);
  }
  async end() {
    await this.f.write(this.first ? ']\n' : '\n]\n');
    await this.f.close();
  }
  abort() {
    return this.f.remove();
  }
}

class SqlWriter implements RowWriter {
  private readonly f: TextFile;
  private cols: ColumnInfo[] = [];
  private batch: string[] = [];
  constructor(file: string, private readonly table: string, private readonly batchSize = 100) {
    this.f = new TextFile(file);
  }
  async begin(columns: ColumnInfo[]) {
    this.cols = columns;
  }
  async row(values: Cell[]) {
    this.batch.push('(' + values.map((v, i) => cellLiteral(v, this.cols[i])).join(', ') + ')');
    if (this.batch.length >= this.batchSize) {
      await this.flush();
    }
  }
  private async flush() {
    if (!this.batch.length) {
      return;
    }
    const head = `INSERT INTO ${qid(this.table)} (${this.cols.map((c) => qid(c.name)).join(', ')}) VALUES\n`;
    const body = this.batch.join(',\n');
    this.batch = [];
    await this.f.write(head + body + ';\n');
  }
  async end() {
    await this.flush();
    await this.f.close();
  }
  abort() {
    return this.f.remove();
  }
}

class MarkdownWriter implements RowWriter {
  private readonly f: TextFile;
  constructor(file: string) {
    this.f = new TextFile(file);
  }
  private esc(v: Cell) {
    return v === null ? '*NULL*' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  }
  async begin(columns: ColumnInfo[]) {
    await this.f.write(`| ${columns.map((c) => this.esc(c.name)).join(' | ')} |\n|${columns.map((c) => (c.numeric ? ' ---: ' : ' --- ')).join('|')}|\n`);
  }
  row(values: Cell[]) {
    return this.f.write(`| ${values.map((v) => this.esc(v)).join(' | ')} |\n`);
  }
  end() {
    return this.f.close();
  }
  abort() {
    return this.f.remove();
  }
}

class XlsxWriter implements RowWriter {
  private readonly wb: ExcelJS.stream.xlsx.WorkbookWriter;
  private sheet!: ExcelJS.Worksheet;
  private cols: ColumnInfo[] = [];
  constructor(private readonly file: string, private readonly sheetName: string) {
    this.wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true });
  }
  async begin(columns: ColumnInfo[]) {
    this.cols = columns;
    this.sheet = this.wb.addWorksheet(this.sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, '_') || 'Sheet1', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    this.sheet.columns = columns.map((c) => ({ header: c.name, key: c.name, width: Math.min(50, Math.max(10, c.name.length + 2)) }));
    this.sheet.getRow(1).font = { bold: true };
    this.sheet.getRow(1).commit();
  }
  async row(values: Cell[]) {
    const out = values.map((v, i) => {
      if (v !== null && this.cols[i].numeric) {
        const n = Number(v);
        if (Number.isFinite(n) && Math.abs(n) < Number.MAX_SAFE_INTEGER) {
          return n;
        }
      }
      return v;
    });
    this.sheet.addRow(out).commit();
  }
  async end() {
    this.sheet.commit();
    await this.wb.commit();
  }
  async abort() {
    try {
      await this.wb.commit();
    } catch {
      // ignore
    }
    await fs.promises.rm(this.file, { force: true });
  }
}

export function createWriter(format: ExportFormat, file: string, tableName: string): RowWriter {
  switch (format) {
    case 'csv':
      return new DelimitedWriter(file, ',');
    case 'tsv':
      return new DelimitedWriter(file, '\t');
    case 'json':
      return new JsonWriter(file);
    case 'sql':
      return new SqlWriter(file, tableName);
    case 'markdown':
      return new MarkdownWriter(file);
    case 'xlsx':
      return new XlsxWriter(file, tableName || path.basename(file, '.xlsx'));
  }
}

/** Export-safe cell: binary values are always written in full. */
export function exportCell(v: unknown): Cell {
  if (v === null || v === undefined) {
    return null;
  }
  if (Buffer.isBuffer(v)) {
    return '0x' + v.toString('hex').toUpperCase();
  }
  if (typeof v === 'string' || typeof v === 'number') {
    return v;
  }
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (v instanceof Date) {
    return v.toISOString();
  }
  return JSON.stringify(v);
}

/**
 * Streams the rows of a SELECT. Columns resolve when the server sends the
 * field list; rows are yielded with back-pressure.
 */
export function streamQuery(conn: mysql.Connection, sql: string, values: unknown[] = []): { columns: Promise<ColumnInfo[]>; rows: AsyncIterable<unknown[]> } {
  const q = conn.query({ sql, values, rowsAsArray: true });
  const columns = new Promise<ColumnInfo[]>((resolve, reject) => {
    q.once('fields', (fields: mysql.FieldPacket[] | undefined) => resolve((fields ?? []).map(columnFromField)));
    q.once('error', reject);
    q.once('end', () => resolve([]));
  });
  const stream = q.stream({ objectMode: true, highWaterMark: 500 });
  return { columns, rows: stream as AsyncIterable<unknown[]> };
}
