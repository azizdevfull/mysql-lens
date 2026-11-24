import * as path from 'node:path';
import type { ConnectionManager } from '../connections/manager';
import type { SchemaService } from '../schema';
import type { ImportSourceOptions, ImportToExtension, ImportToWebview } from '../shared/protocol';
import { detectOptions, preview, runDataImport } from '../io/dataImport';
import { errorText } from './errors';
import type { UiHost } from './host';

export interface ImportCallbacks {
  setTitle(title: string): void;
  close(): void;
  openTable(table: string): void;
  /** Called after rows were imported, so trees and open tables can refresh. */
  done(): void;
}

/** Wizard: pick a CSV/JSON/Excel file, map columns, import into a table. */
export class ImportController {
  private file?: string;
  private options?: ImportSourceOptions;
  private cancelled = false;
  private running = false;

  constructor(
    private readonly host: UiHost,
    private readonly post: (m: ImportToWebview) => void,
    private readonly conns: ConnectionManager,
    private readonly schema: SchemaService,
    private readonly connId: string,
    private readonly db: string,
    private readonly table: string | undefined,
    private readonly cb: ImportCallbacks,
  ) {}

  dispose(): void {
    this.cancelled = true;
  }

  private async sendPreview(): Promise<void> {
    if (!this.file || !this.options) return;
    try {
      this.post({ type: 'preview', preview: await preview(this.file, this.options) });
    } catch (e) {
      this.post({ type: 'previewError', message: errorText(e) });
    }
  }

  async receive(m: ImportToExtension): Promise<void> {
    try {
      switch (m.type) {
        case 'ready': {
          const tables = (await this.schema.tables(this.connId, this.db)).filter((t) => t.kind === 'table').map((t) => t.name);
          this.post({ type: 'init', target: { database: this.db, tables }, preselectTable: this.table });
          return;
        }
        case 'pickFile': {
          const file = await this.host.openFile({
            filters: { 'Data files': ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson', 'xlsx', 'xlsm'], 'All files': ['*'] },
            openLabel: 'Select',
          });
          if (!file) return;
          this.file = file;
          this.options = await detectOptions(file);
          this.cb.setTitle(`Import ${path.basename(file)}`);
          await this.sendPreview();
          return;
        }
        case 'reparse':
          this.options = m.options;
          await this.sendPreview();
          return;
        case 'loadTable': {
          const meta = await this.schema.gridColumns(this.connId, this.db, m.table);
          this.post({ type: 'tableColumns', table: m.table, columns: meta.columns });
          return;
        }
        case 'cancel':
          this.cancelled = true;
          return;
        case 'close':
          this.cb.close();
          return;
        case 'openTable':
          this.cb.close();
          this.cb.openTable(m.table);
          return;
        case 'run':
          await this.run(m.plan);
          return;
      }
    } catch (e) {
      this.host.error(errorText(e));
    }
  }

  private async run(plan: Extract<ImportToExtension, { type: 'run' }>['plan']): Promise<void> {
    if (!this.file || !this.options || this.running) return;
    if (this.conns.config(this.connId).readOnly) {
      this.post({ type: 'finished', ok: false, message: 'This connection is read-only.' });
      return;
    }
    this.running = true;
    this.cancelled = false;
    const conn = await this.conns.dedicated(this.connId, this.db);
    const started = Date.now();
    try {
      const n = await runDataImport(conn, this.db, this.file, this.options, plan, (p) => this.post({ type: 'progress', done: p.rows, total: null, message: p.message }), () => this.cancelled);
      this.schema.invalidate(this.connId, this.db);
      this.cb.done();
      this.post({ type: 'finished', ok: true, message: `Imported ${n.toLocaleString()} rows into ${plan.table} in ${((Date.now() - started) / 1000).toFixed(1)} s` });
    } catch (e) {
      const msg = errorText(e);
      this.post({ type: 'finished', ok: false, message: msg === 'cancelled' ? 'Import cancelled. No rows were saved.' : `Import failed, nothing was saved: ${msg}` });
    } finally {
      this.running = false;
      conn.destroy();
    }
  }
}
