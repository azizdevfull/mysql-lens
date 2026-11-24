import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, PickItem, Settings, UiHost } from './core/host';

/** UiHost backed by the VS Code API. */
export class VscodeHost implements UiHost {
  settings(): Settings {
    const c = vscode.workspace.getConfiguration('mysqlLens');
    return {
      maxRows: c.get('maxRows', DEFAULT_SETTINGS.maxRows),
      pageSize: c.get('pageSize', DEFAULT_SETTINGS.pageSize),
      showSystemDatabases: c.get('showSystemDatabases', DEFAULT_SETTINGS.showSystemDatabases),
      confirmDangerousQueries: c.get('confirmDangerousQueries', DEFAULT_SETTINGS.confirmDangerousQueries),
      historySize: c.get('historySize', DEFAULT_SETTINGS.historySize),
    };
  }

  info(message: string, ...actions: string[]): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showInformationMessage(message, ...actions));
  }

  warn(message: string, ...actions: string[]): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showWarningMessage(message, ...actions));
  }

  error(message: string): void {
    if (message !== 'Cancelled.') {
      void vscode.window.showErrorMessage(`MySQL Lens: ${message}`);
    }
  }

  confirm(message: string, detail: string, ...actions: string[]): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions));
  }

  pick<T extends PickItem>(items: T[], opts: { title: string; placeholder?: string }): Promise<T | undefined> {
    return Promise.resolve(vscode.window.showQuickPick(items, { title: opts.title, placeHolder: opts.placeholder }));
  }

  pickMany<T extends PickItem>(items: T[], opts: { title: string; placeholder?: string }): Promise<T[] | undefined> {
    return Promise.resolve(vscode.window.showQuickPick(items, { title: opts.title, placeHolder: opts.placeholder, canPickMany: true }));
  }

  input(opts: { title: string; prompt?: string; value?: string; password?: boolean; validate?: (v: string) => string | undefined }): Promise<string | undefined> {
    return Promise.resolve(
      vscode.window.showInputBox({ title: opts.title, prompt: opts.prompt, value: opts.value, password: opts.password, ignoreFocusOut: opts.password, validateInput: opts.validate }),
    );
  }

  async saveFile(opts: { defaultName: string; filters: Record<string, string[]>; saveLabel?: string }): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(folder, opts.defaultName)), filters: opts.filters, saveLabel: opts.saveLabel });
    return uri?.fsPath;
  }

  async openFile(opts: { filters: Record<string, string[]>; openLabel?: string }): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: opts.filters, openLabel: opts.openLabel });
    return uris?.[0]?.fsPath;
  }

  withProgress<T>(title: string, task: Parameters<UiHost['withProgress']>[1]): Promise<T> {
    return Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) =>
        task(
          { report: (message, increment) => progress.report({ message, increment }) },
          { isCancelled: () => token.isCancellationRequested, onCancel: (fn) => token.onCancellationRequested(fn) },
        ),
      ),
    ) as Promise<T>;
  }

  async copy(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('$(check) Copied to clipboard', 2000);
  }

  async openText(text: string, language: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content: text, language });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  async openPath(p: string, isText: boolean): Promise<void> {
    const uri = vscode.Uri.file(p);
    if (isText) {
      await vscode.window.showTextDocument(uri);
    } else {
      await vscode.env.openExternal(uri);
    }
  }

  async revealPath(p: string): Promise<void> {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
  }
}
