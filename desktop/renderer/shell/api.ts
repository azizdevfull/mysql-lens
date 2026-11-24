import type { Api, ApiName, ShellEvent } from '../../shared/ipc';

interface LensBridge {
  invoke(name: string, ...args: unknown[]): Promise<unknown>;
  on(cb: (ev: ShellEvent) => void): void;
  onMenu(cb: (action: string) => void): void;
}

declare global {
  interface Window {
    lens: LensBridge;
  }
}

type Ret<K extends ApiName> = Awaited<ReturnType<Api[K]>>;

export function invoke<K extends ApiName>(name: K, ...args: Parameters<Api[K]>): Promise<Ret<K>> {
  return window.lens.invoke(name, ...args) as Promise<Ret<K>>;
}

const listeners = new Set<(ev: ShellEvent) => void>();
window.lens.on((ev) => listeners.forEach((l) => l(ev)));

export function onEvent(cb: (ev: ShellEvent) => void): void {
  listeners.add(cb);
}

let seq = 0;
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}
