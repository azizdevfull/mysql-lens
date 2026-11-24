interface VsCodeApi<S> {
  postMessage(msg: unknown): void;
  getState(): S | undefined;
  setState(s: S): void;
}

declare function acquireVsCodeApi<S = unknown>(): VsCodeApi<S>;

let api: VsCodeApi<unknown> | undefined;

export function vscode<S = unknown>(): VsCodeApi<S> {
  api ??= acquireVsCodeApi();
  return api as VsCodeApi<S>;
}

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

/** Small hyperscript helper: h('div.cls', {attrs}, ...children). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | `${K}.${string}` | `${K}#${string}`, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const [base, ...classes] = tag.split('.');
  const [name, id] = base.split('#');
  const el = document.createElement(name as K);
  if (id) {
    el.id = id;
  }
  if (classes.length) {
    el.className = classes.join(' ');
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) {
        continue;
      }
      if (k === 'class') {
        el.className = [el.className, v as string].filter(Boolean).join(' ');
      } else if (k === 'style') {
        if (typeof v === 'string') {
          el.setAttribute('style', v);
        } else {
          Object.assign(el.style, v);
        }
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k in el) {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) {
      continue;
    }
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function icon(name: string, extra = ''): HTMLElement {
  return h('i', { class: `codicon codicon-${name} ${extra}`.trim() });
}

export function iconButton(name: string, title: string, onClick: (e: MouseEvent) => void, label?: string): HTMLButtonElement {
  return h('button.icon-btn', { title, 'aria-label': title, onclick: onClick }, icon(name), label ? h('span', null, label) : null);
}

let toastHost: HTMLElement | undefined;

export function toast(message: string, level: 'info' | 'warn' | 'error' = 'info', ms = 3500): void {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast ${level === 'info' ? '' : level}` }, icon(level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'check'), h('span', null, message));
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

export interface ModalOptions {
  title: string;
  icon?: string;
  body: Node;
  wide?: boolean;
  buttons: { label: string; kind?: 'primary' | 'secondary' | 'danger'; value: string }[];
}

/** Shows a modal and resolves with the clicked button's value ('' on Escape). */
export function modal(o: ModalOptions): Promise<string> {
  return new Promise((resolve) => {
    const close = (v: string) => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close('');
      }
    };
    const buttons = o.buttons.map((b) =>
      h('button', { class: `btn ${b.kind === 'primary' || !b.kind ? '' : b.kind}`, onclick: () => close(b.value) }, b.label),
    );
    const back = h(
      'div.modal-backdrop',
      { onmousedown: (e: MouseEvent) => e.target === back && close('') },
      h(
        'div.modal',
        { style: o.wide ? { width: 'min(1000px, 100%)' } : undefined, role: 'dialog', 'aria-modal': 'true' },
        h('header', null, o.icon ? icon(o.icon) : null, o.title),
        h('div.body', null, o.body),
        h('footer', null, buttons),
      ),
    );
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    (buttons.find((_, i) => (o.buttons[i].kind ?? 'primary') === 'primary') ?? buttons[0])?.focus();
  });
}

export interface MenuItem {
  label: string;
  icon?: string;
  key?: string;
  disabled?: boolean;
  run?: () => void;
}

/** Opens a context menu at the mouse position. `null` entries are dividers. */
export function contextMenu(x: number, y: number, items: (MenuItem | null)[]): void {
  document.querySelector('.ctx-menu')?.remove();
  const menu = h(
    'div.ctx-menu',
    { role: 'menu' },
    items.map((it) =>
      it === null
        ? h('div.divider')
        : h(
            'div',
            {
              class: `item ${it.disabled ? 'disabled' : ''}`,
              role: 'menuitem',
              onclick: () => {
                menu.remove();
                it.run?.();
              },
            },
            it.icon ? icon(it.icon) : h('span', { style: { width: '16px' } }),
            h('span', null, it.label),
            it.key ? h('span.key', null, it.key) : null,
          ),
    ),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  const dismiss = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('blur', dismissBlur);
    }
  };
  const dismissBlur = () => {
    menu.remove();
    document.removeEventListener('mousedown', dismiss, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    window.addEventListener('blur', dismissBlur, { once: true });
  });
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
