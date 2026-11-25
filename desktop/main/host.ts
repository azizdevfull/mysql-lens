import * as fs from 'node:fs';
import { BrowserWindow, clipboard, dialog, shell } from 'electron';
import { CancelToken, DEFAULT_SETTINGS, PickItem, Progress, Settings, UiHost } from '../../src/core/host';
import type { ShellEvent, RpcRequest } from '../shared/ipc';
import { JsonFile } from './store';

export interface DesktopSettings extends Settings {
  theme: 'system' | 'dark' | 'light';
  /** GPU compositing. Off by default: saves ~60 MB and this UI does not need it. */
  hardwareAcceleration: boolean;
}

export const settingsFile = () => new JsonFile<Partial<DesktopSettings>>('settings.json', {});

/**
 * UiHost for the desktop app. Native dialogs for files and confirmations;
 * pickers, inputs, toasts and progress are drawn by the shell renderer and
 * answered over IPC.
 */
export class DesktopHost implements UiHost {
  private nextId = 1;
  private readonly pending = new Map<number, (v: unknown) => void>();
  private readonly cancelHandlers = new Map<number, { cancelled: boolean; fns: (() => void)[] }>();
  private readonly settingsStore = settingsFile();

  constructor(private readonly win: () => BrowserWindow | undefined) {}

  send(ev: ShellEvent): void {
    const w = this.win();
    if (w && !w.isDestroyed()) w.webContents.send('lens:event', ev);
  }

  private rpc<T>(req: RpcRequest): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.pending.set(id, resolve as (v: unknown) => void);
      this.send({ type: 'rpc', id, req });
    });
  }

  /** Called from IPC when the renderer answers an rpc. */
  reply(id: number, value: unknown): void {
    const r = this.pending.get(id);
    this.pending.delete(id);
    r?.(value);
  }

  cancelProgress(id: number): void {
    const h = this.cancelHandlers.get(id);
    if (h && !h.cancelled) {
      h.cancelled = true;
      h.fns.forEach((f) => f());
    }
  }

  settings(): DesktopSettings {
    return { ...DEFAULT_SETTINGS, theme: 'system', hardwareAcceleration: false, ...this.settingsStore.read() };
  }

  saveSettings(patch: Partial<DesktopSettings>): DesktopSettings {
    const next = { ...this.settingsStore.read(), ...patch };
    this.settingsStore.write(next);
    return this.settings();
  }

  info(message: string, ...actions: string[]): Promise<string | undefined> {
    return this.rpc({ kind: 'toast', level: 'info', message, actions });
  }

  warn(message: string, ...actions: string[]): Promise<string | undefined> {
    return this.rpc({ kind: 'toast', level: 'warn', message, actions });
  }

  error(message: string): void {
    if (message !== 'Cancelled.') void this.rpc({ kind: 'toast', level: 'error', message, actions: [] });
  }

  async confirm(message: string, detail: string, ...actions: string[]): Promise<string | undefined> {
    const w = this.win();
    const buttons = [...actions, 'Cancel'];
    const opts = { type: 'warning' as const, message, detail, buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true, title: 'MySQL Lens' };
    const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return r.response < actions.length ? actions[r.response] : undefined;
  }

  async pick<T extends PickItem>(items: T[], opts: { title: string; placeholder?: string }): Promise<T | undefined> {
    const i = await this.rpc<number | null>({ kind: 'pick', title: opts.title, placeholder: opts.placeholder, many: false, items: items.map(strip) });
    return i === null || i === undefined ? undefined : items[i as number];
  }

  async pickMany<T extends PickItem>(items: T[], opts: { title: string; placeholder?: string }): Promise<T[] | undefined> {
    const idx = await this.rpc<number[] | null>({ kind: 'pick', title: opts.title, placeholder: opts.placeholder, many: true, items: items.map(strip) });
    return idx ? idx.map((i) => items[i]) : undefined;
  }

  async input(opts: { title: string; prompt?: string; value?: string; password?: boolean; validate?: (v: string) => string | undefined }): Promise<string | undefined> {
    // Validation runs here, so the renderer just re-asks with the message.
    let value = opts.value ?? '';
    let error: string | undefined;
    for (;;) {
      const v = await this.rpc<string | null>({ kind: 'input', title: opts.title, prompt: opts.prompt, value, password: !!opts.password, error });
      if (v === null || v === undefined) return undefined;
      error = opts.validate?.(v);
      if (!error) return v;
      value = v;
    }
  }

  async saveFile(opts: { defaultName: string; filters: Record<string, string[]>; saveLabel?: string }): Promise<string | undefined> {
    const w = this.win();
    const o = { defaultPath: opts.defaultName, buttonLabel: opts.saveLabel, filters: toFilters(opts.filters) };
    const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o);
    return r.canceled ? undefined : r.filePath;
  }

  async openFile(opts: { filters: Record<string, string[]>; openLabel?: string }): Promise<string | undefined> {
    const w = this.win();
    const o = { buttonLabel: opts.openLabel, filters: toFilters(opts.filters), properties: ['openFile' as const] };
    const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
    return r.canceled ? undefined : r.filePaths[0];
  }

  async withProgress<T>(title: string, task: (progress: Progress, token: CancelToken) => Promise<T>): Promise<T> {
    const id = this.nextId++;
    const state = { cancelled: false, fns: [] as (() => void)[] };
    this.cancelHandlers.set(id, state);
    this.send({ type: 'progress', id, phase: 'start', title });
    let pct = 0;
    try {
      return await task(
        {
          report: (message, increment) => {
            if (increment) pct = Math.min(100, pct + increment);
            this.send({ type: 'progress', id, phase: 'report', message, percent: increment !== undefined ? pct : undefined });
          },
        },
        { isCancelled: () => state.cancelled, onCancel: (fn) => state.fns.push(fn) },
      );
    } finally {
      this.cancelHandlers.delete(id);
      this.send({ type: 'progress', id, phase: 'end' });
    }
  }

  async copy(text: string): Promise<void> {
    clipboard.writeText(text);
    this.send({ type: 'status', message: 'Copied to clipboard' });
  }

  async openText(text: string, language: string): Promise<void> {
    this.send({ type: 'openSql', text, language });
  }

  async openPath(p: string, isText: boolean): Promise<void> {
    if (isText && /\.(sql|txt|md|csv|tsv|json)$/i.test(p) && fs.statSync(p).size < 20 * 1024 * 1024) {
      this.send({ type: 'openSql', text: fs.readFileSync(p, 'utf8'), language: p.endsWith('.sql') ? 'sql' : 'plaintext', title: p.split(/[\\/]/).pop(), path: p });
      return;
    }
    await shell.openPath(p);
  }

  async revealPath(p: string): Promise<void> {
    shell.showItemInFolder(p);
  }
}

function strip(i: PickItem): PickItem {
  return { label: i.label, description: i.description, detail: i.detail, picked: i.picked };
}

function toFilters(f: Record<string, string[]>) {
  return Object.entries(f).map(([name, extensions]) => ({ name, extensions }));
}
