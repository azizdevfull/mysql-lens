import * as path from 'node:path';
import type { Cell, ColumnInfo, ExportFormat } from '../shared/protocol';
import type { ConnectionManager } from '../connections/manager';
import { createWriter, exportCell, FORMAT_INFO, streamQuery } from '../io/exporters';
import type { UiHost } from './host';

export async function pickFormat(host: UiHost): Promise<ExportFormat | undefined> {
  const items = (Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => ({
    label: FORMAT_INFO[f].label,
    description: `.${FORMAT_INFO[f].ext}`,
    detail: FORMAT_INFO[f].detail,
    format: f,
  }));
  return (await host.pick(items, { title: 'Export format', placeholder: 'Choose a file format' }))?.format;
}

export function pickSaveFile(host: UiHost, format: ExportFormat, baseName: string): Promise<string | undefined> {
  const info = FORMAT_INFO[format];
  const safe = baseName.replace(/[\\/:*?"<>|]+/g, '_') || 'export';
  return host.saveFile({ defaultName: `${safe}.${info.ext}`, filters: { [info.label]: [info.ext], 'All files': ['*'] }, saveLabel: 'Export' });
}

/** Writes rows to a file with cancellable progress, then offers to open it. */
export async function writeExport(
  host: UiHost,
  opts: {
    format: ExportFormat;
    file: string;
    tableName: string;
    columns: () => Promise<ColumnInfo[]>;
    rows: AsyncIterable<Cell[]> | Iterable<Cell[]>;
    total?: number;
    onCancel?: () => void;
  },
): Promise<void> {
  const writer = createWriter(opts.format, opts.file, opts.tableName);
  const name = path.basename(opts.file);
  let count = 0;
  const done = await host.withProgress(`Exporting ${name}`, async (progress, token) => {
    token.onCancel(() => opts.onCancel?.());
    try {
      await writer.begin(await opts.columns());
      let lastReport = 0;
      let lastPct = 0;
      for await (const row of opts.rows) {
        if (token.isCancelled()) {
          await writer.abort();
          return false;
        }
        await writer.row(row);
        count++;
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          const pct = opts.total ? Math.min(100, (count / opts.total) * 100) : 0;
          progress.report(`${count.toLocaleString()} rows`, opts.total ? pct - lastPct : undefined);
          lastPct = pct;
        }
      }
      await writer.end();
      return true;
    } catch (e) {
      await writer.abort().catch(() => undefined);
      if (token.isCancelled()) {
        return false;
      }
      throw e;
    }
  });
  if (!done) {
    void host.info('Export cancelled.');
    return;
  }
  const action = await host.info(`Exported ${count.toLocaleString()} rows to ${name}`, 'Open', 'Reveal in Folder');
  if (action === 'Open') {
    await host.openPath(opts.file, opts.format !== 'xlsx');
  } else if (action === 'Reveal in Folder') {
    await host.revealPath(opts.file);
  }
}

export async function* exportRows(rows: AsyncIterable<unknown[]>): AsyncIterable<Cell[]> {
  for await (const r of rows) {
    yield r.map(exportCell);
  }
}

/** Streams a query straight into an export file. */
export async function exportQuery(
  host: UiHost,
  conns: ConnectionManager,
  connId: string,
  db: string | undefined,
  sql: string,
  format: ExportFormat,
  file: string,
  tableName: string,
  total?: number,
): Promise<void> {
  const conn = await conns.dedicated(connId, db);
  try {
    const s = streamQuery(conn, sql);
    await writeExport(host, { format, file, tableName, columns: () => s.columns, rows: exportRows(s.rows), total, onCancel: () => conn.destroy() });
  } finally {
    conn.destroy();
  }
}
