/**
 * What the shared controllers need from the surrounding app (VS Code or the
 * desktop app). Nothing in src/core imports `vscode` or `electron`.
 */

export interface Settings {
  maxRows: number;
  pageSize: number;
  showSystemDatabases: boolean;
  confirmDangerousQueries: boolean;
  historySize: number;
}

export const DEFAULT_SETTINGS: Settings = {
  maxRows: 5000,
  pageSize: 200,
  showSystemDatabases: false,
  confirmDangerousQueries: true,
  historySize: 500,
};

export interface PickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
}

export interface Progress {
  /** `increment` is a percentage of the whole task, like VS Code's progress API. */
  report(message: string, increment?: number): void;
}

export interface CancelToken {
  isCancelled(): boolean;
  onCancel(fn: () => void): void;
}

export interface UiHost {
  settings(): Settings;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string): void;
  /** Modal confirmation. Resolves with the chosen action or undefined. */
  confirm(message: string, detail: string, ...actions: string[]): Promise<string | undefined>;
  pick<T extends PickItem>(items: T[], opts: { title: string; placeholder?: string }): Promise<T | undefined>;
  pickMany<T extends PickItem>(items: T[], opts: { title: string; placeholder?: string }): Promise<T[] | undefined>;
  input(opts: { title: string; prompt?: string; value?: string; password?: boolean; validate?: (v: string) => string | undefined }): Promise<string | undefined>;
  /** Returns a filesystem path. */
  saveFile(opts: { defaultName: string; filters: Record<string, string[]>; saveLabel?: string }): Promise<string | undefined>;
  openFile(opts: { filters: Record<string, string[]>; openLabel?: string }): Promise<string | undefined>;
  withProgress<T>(title: string, task: (progress: Progress, token: CancelToken) => Promise<T>): Promise<T>;
  copy(text: string): Promise<void>;
  openText(text: string, language: string): Promise<void>;
  /** Opens a file with its default app (or in the editor for text files). */
  openPath(path: string, isText: boolean): Promise<void>;
  revealPath(path: string): Promise<void>;
}
