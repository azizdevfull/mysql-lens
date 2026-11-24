import { contextBridge, ipcRenderer } from 'electron';

/*
 * One preload for every frame:
 *  - the shell window gets `window.lens` (invoke + events);
 *  - view iframes (grid, connection form, import wizard) get an
 *    `acquireVsCodeApi` shim, so the same UI bundles run unchanged.
 */

function syncThemeClass(): void {
  const light = window.matchMedia('(prefers-color-scheme: light)').matches;
  const apply = () => {
    document.body?.classList.toggle('vscode-light', light);
    document.body?.classList.toggle('vscode-dark', !light);
  };
  if (document.body) apply();
  else window.addEventListener('DOMContentLoaded', apply, { once: true });
}

syncThemeClass();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', syncThemeClass);

if (window.top === window) {
  contextBridge.exposeInMainWorld('lens', {
    invoke: (name: string, ...args: unknown[]) => ipcRenderer.invoke('lens:invoke', name, ...args),
    on: (cb: (ev: unknown) => void) => {
      const l = (_e: unknown, ev: unknown) => cb(ev);
      ipcRenderer.on('lens:event', l);
    },
    onMenu: (cb: (action: string) => void) => {
      ipcRenderer.on('lens:menu', (_e, action: string) => cb(action));
    },
  });
} else {
  const viewId = new URLSearchParams(location.search).get('view') ?? '';
  let state: unknown;
  contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
    postMessage: (m: unknown) => ipcRenderer.send('view:msg', viewId, m),
    getState: () => state,
    setState: (s: unknown) => {
      state = s;
    },
  }));
  ipcRenderer.on('view:msg', (_e, m: unknown) => window.postMessage(m, '*'));
  ipcRenderer.send('view:register', viewId);
}
