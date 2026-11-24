import * as vscode from 'vscode';
import * as path from 'node:path';
import { ConnectionManager } from '../connections/manager';
import { SchemaService } from '../schema';
import type { ImportSourceOptions, ImportToExtension, ImportToWebview } from '../shared/protocol';
import { detectOptions, preview, runDataImport } from '../io/dataImport';
import { errorText } from './connectionForm';
import { webviewHtml, webviewOptions } from './html';

/** Wizard: pick a CSV/JSON/Excel file, map columns, import into a table. */
export function showImportPanel(
  ctx: vscode.ExtensionContext,
  conns: ConnectionManager,
  schema: SchemaService,
  connId: string,
  db: string,
  table: string | undefined,
  onDone: () => void,
): void {
  const cfg = conns.config(connId);
  const panel = vscode.window.createWebviewPanel('mysqlLens.import', `Import into ${db}`, vscode.ViewColumn.Active, webviewOptions(ctx.extensionUri));
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.svg');
  panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, 'importer', 'Import');

  let file: string | undefined;
  let options: ImportSourceOptions | undefined;
  let cancelled = false;
  let running = false;
  const post = (m: ImportToWebview) => void panel.webview.postMessage(m);

  const sendPreview = async () => {
    if (!file || !options) {
      return;
    }
    try {
      post({ type: 'preview', preview: await preview(file, options) });
    } catch (e) {
      post({ type: 'previewError', message: errorText(e) });
    }
  };

  panel.onDidDispose(() => (cancelled = true));
  panel.webview.onDidReceiveMessage(async (m: ImportToExtension) => {
    try {
      switch (m.type) {
        case 'ready': {
          const tables = (await schema.tables(connId, db)).filter((t) => t.kind === 'table').map((t) => t.name);
          post({ type: 'init', target: { database: db, tables }, preselectTable: table });
          break;
        }
        case 'pickFile': {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Data files': ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson', 'xlsx', 'xlsm'], 'All files': ['*'] },
            openLabel: 'Select',
          });
          if (!picked?.[0]) {
            break;
          }
          file = picked[0].fsPath;
          options = await detectOptions(file);
          panel.title = `Import ${path.basename(file)}`;
          await sendPreview();
          break;
        }
        case 'reparse':
          options = m.options;
          await sendPreview();
          break;
        case 'loadTable': {
          const meta = await schema.gridColumns(connId, db, m.table);
          post({ type: 'tableColumns', table: m.table, columns: meta.columns });
          break;
        }
        case 'cancel':
          cancelled = true;
          break;
        case 'close':
          panel.dispose();
          break;
        case 'openTable':
          panel.dispose();
          await vscode.commands.executeCommand('mysqlLens.openTable', { kind: 'table', connId, db, name: m.table });
          break;
        case 'run': {
          if (!file || !options || running) {
            break;
          }
          if (cfg.readOnly) {
            post({ type: 'finished', ok: false, message: 'This connection is read-only.' });
            break;
          }
          running = true;
          cancelled = false;
          const conn = await conns.dedicated(connId, db);
          const started = Date.now();
          try {
            const n = await runDataImport(
              conn,
              db,
              file,
              options,
              m.plan,
              (p) => post({ type: 'progress', done: p.rows, total: null, message: p.message }),
              () => cancelled,
            );
            schema.invalidate(connId, db);
            onDone();
            post({ type: 'finished', ok: true, message: `Imported ${n.toLocaleString()} rows into ${m.plan.table} in ${((Date.now() - started) / 1000).toFixed(1)} s` });
          } catch (e) {
            const msg = errorText(e);
            post({ type: 'finished', ok: false, message: msg === 'cancelled' ? 'Import cancelled. No rows were saved.' : `Import failed, nothing was saved: ${msg}` });
          } finally {
            running = false;
            conn.destroy();
          }
          break;
        }
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`MySQL Lens: ${errorText(e)}`);
    }
  });
}
