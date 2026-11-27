import type { DumpOptions, ExportFormat } from './types';

/** File type name and extension of each export format. */
export const EXPORT_EXT: Record<ExportFormat, [string, string]> = {
  csv: ['CSV', 'csv'],
  tsv: ['TSV', 'tsv'],
  json: ['JSON', 'json'],
  sql: ['SQL', 'sql'],
  markdown: ['Markdown', 'md'],
  xlsx: ['Excel', 'xlsx'],
};

/** `shop_20261127_1430.sql` (or `.sql.gz`). */
export function dumpFileName(o: DumpOptions): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');
  return `${o.database}_${stamp}.sql${o.gzip ? '.gz' : ''}`;
}
