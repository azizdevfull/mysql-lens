import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Cell, ColumnInfo, ExportFormat } from '../shared/protocol';
import { createWriter, FORMAT_INFO } from './exporters';

export async function pickFormat(): Promise<ExportFormat | undefined> {
  const items = (Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => ({
    label: FORMAT_INFO[f].label,
    description: `.${FORMAT_INFO[f].ext}`,
    detail: FORMAT_INFO[f].detail,
    format: f,
  }));
  const picked = await vscode.window.showQuickPick(items, { title: 'Export format', placeHolder: 'Choose a file format' });
  return picked?.format;
}

export async function pickSaveFile(format: ExportFormat, baseName: string): Promise<vscode.Uri | undefined> {
  const info = FORMAT_INFO[format];
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const safe = baseName.replace(/[\\/:*?"<>|]+/g, '_') || 'export';
  const defaultUri = folder ? vscode.Uri.joinPath(folder, `${safe}.${info.ext}`) : vscode.Uri.file(path.join(os.homedir(), `${safe}.${info.ext}`));
  return vscode.window.showSaveDialog({ defaultUri, filters: { [info.label]: [info.ext], 'All files': ['*'] }, saveLabel: 'Export' });
}

/**
 * Writes rows to a file with a cancellable progress notification.
 * `total` is used for the progress bar when known.
 */
export async function writeExport(opts: {
  format: ExportFormat;
  file: vscode.Uri;
  tableName: string;
  columns: () => Promise<ColumnInfo[]>;
  rows: AsyncIterable<Cell[]> | Iterable<Cell[]>;
  total?: number;
  onCancel?: () => void;
}): Promise<void> {
  const writer = createWriter(opts.format, opts.file.fsPath, opts.tableName);
  const name = path.basename(opts.file.fsPath);
  let count = 0;
  const done = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Exporting ${name}`, cancellable: true },
    async (progress, token) => {
      token.onCancellationRequested(() => opts.onCancel?.());
      try {
        await writer.begin(await opts.columns());
        let lastReport = 0;
        let lastPct = 0;
        for await (const row of opts.rows) {
          if (token.isCancellationRequested) {
            await writer.abort();
            return false;
          }
          await writer.row(row);
          count++;
          const now = Date.now();
          if (now - lastReport > 250) {
            lastReport = now;
            const pct = opts.total ? Math.min(100, (count / opts.total) * 100) : 0;
            progress.report({ message: `${count.toLocaleString()} rows`, increment: opts.total ? pct - lastPct : undefined });
            lastPct = pct;
          }
        }
        await writer.end();
        return true;
      } catch (e) {
        await writer.abort().catch(() => undefined);
        if (token.isCancellationRequested) {
          return false;
        }
        throw e;
      }
    },
  );
  if (!done) {
    void vscode.window.showInformationMessage('Export cancelled.');
    return;
  }
  const action = await vscode.window.showInformationMessage(`Exported ${count.toLocaleString()} rows to ${name}`, 'Open', 'Reveal in Folder');
  if (action === 'Open') {
    if (opts.format === 'xlsx') {
      await vscode.env.openExternal(opts.file);
    } else {
      await vscode.window.showTextDocument(opts.file);
    }
  } else if (action === 'Reveal in Folder') {
    await vscode.commands.executeCommand('revealFileInOS', opts.file);
  }
}
