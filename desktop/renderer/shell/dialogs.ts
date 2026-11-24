import type { PickItem } from '../../../src/core/host';
import type { RpcRequest } from '../../shared/ipc';
import { h, icon } from '../../../webview-ui/common/dom';
import { invoke } from './api';

/* ------------------------------ quick pick ------------------------------ */

/** VS Code-style quick pick. Resolves with the index (or indexes) or null. */
export function quickPick(title: string, items: PickItem[], many: boolean, placeholder?: string): Promise<number | number[] | null> {
  return new Promise((resolve) => {
    const checked = new Set(items.map((it, i) => (it.picked ? i : -1)).filter((i) => i >= 0));
    let active = 0;
    let visible = items.map((_, i) => i);
    const filter = h('input.qp-input', { type: 'text', placeholder: placeholder ?? (many ? 'Type to filter, Space to toggle, Enter to confirm' : 'Type to filter'), spellcheck: false });
    const list = h('div.qp-list', { role: 'listbox' });
    const count = h('span.qp-count');
    const done = (v: number | number[] | null) => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      visible = items.map((_, i) => i).filter((i) => !q || `${items[i].label} ${items[i].description ?? ''} ${items[i].detail ?? ''}`.toLowerCase().includes(q));
      active = Math.min(active, Math.max(0, visible.length - 1));
      list.replaceChildren(
        ...visible.map((i, n) => {
          const it = items[i];
          const row = h(
            'div',
            { class: `qp-item ${n === active ? 'active' : ''}`, dataset: { n: String(n) } },
            many ? h('span', { class: `qp-check codicon codicon-${checked.has(i) ? 'pass-filled' : 'circle-large-outline'}` }) : null,
            h('div.qp-text', null, h('div.qp-row', null, h('span.qp-label', null, it.label), it.description ? h('span.qp-desc', null, it.description) : null), it.detail ? h('div.qp-detail', null, it.detail) : null),
          );
          row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            active = n;
            if (many) {
              toggle(i);
            } else {
              done(i);
            }
          });
          return row;
        }),
      );
      if (!visible.length) list.append(h('div.qp-empty', null, 'No matching items'));
      count.textContent = many ? `${checked.size} selected` : '';
      (list.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    };
    const toggle = (i: number) => {
      if (checked.has(i)) checked.delete(i);
      else checked.add(i);
      render();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, Math.min(visible.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (many) done([...checked].sort((a, b) => a - b));
        else if (visible.length) done(visible[active]);
      } else if (many && e.key === ' ' && document.activeElement !== filter) {
        e.preventDefault();
        if (visible.length) toggle(visible[active]);
      } else if (many && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const all = visible.every((i) => checked.has(i));
        visible.forEach((i) => (all ? checked.delete(i) : checked.add(i)));
        render();
      }
    };
    filter.addEventListener('input', () => {
      active = 0;
      render();
    });
    const footer = many
      ? h('div.qp-footer', null, count, h('span.spacer'), h('button.btn.secondary', { onclick: () => done(null) }, 'Cancel'), h('button.btn', { onclick: () => done([...checked].sort((a, b) => a - b)) }, 'OK'))
      : null;
    const back = h(
      'div.qp-backdrop',
      { onmousedown: (e: MouseEvent) => e.target === back && done(null) },
      h('div.qp', null, h('div.qp-title', null, title), filter, list, footer),
    );
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    render();
    filter.focus();
  });
}

/* ------------------------------ input box ------------------------------ */

export function inputBox(req: Extract<RpcRequest, { kind: 'input' }>): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input.qp-input', { type: req.password ? 'password' : 'text', value: req.value, spellcheck: false });
    const done = (v: string | null) => {
      back.remove();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      else if (e.key === 'Escape') done(null);
    });
    const back = h(
      'div.qp-backdrop',
      { onmousedown: (e: MouseEvent) => e.target === back && done(null) },
      h(
        'div.qp',
        null,
        h('div.qp-title', null, req.title),
        input,
        req.prompt ? h('div.qp-prompt', null, req.prompt) : null,
        req.error ? h('div.qp-error', null, icon('error'), ' ', req.error) : null,
        h('div.qp-footer', null, h('span.spacer'), h('button.btn.secondary', { onclick: () => done(null) }, 'Cancel'), h('button.btn', { onclick: () => done(input.value) }, 'OK')),
      ),
    );
    document.body.append(back);
    input.focus();
    input.select();
  });
}

/* ------------------------------ notifications ------------------------------ */

let host: HTMLElement | undefined;
function notificationHost(): HTMLElement {
  if (!host) {
    host = h('div.notif-host');
    document.body.append(host);
  }
  return host;
}

export function notify(level: 'info' | 'warn' | 'error', message: string, actions: string[] = []): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const close = (v?: string) => {
      if (settled) return;
      settled = true;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 150);
      resolve(v);
    };
    const el = h(
      'div',
      { class: `notif ${level}` },
      icon(level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info', 'notif-icon'),
      h('div.notif-body', null, h('div.notif-msg', null, message), actions.length ? h('div.notif-actions', null, actions.map((a) => h('button.btn.small', { onclick: () => close(a) }, a))) : null),
      h('button.icon-btn.notif-close', { title: 'Close', onclick: () => close() }, icon('close')),
    );
    notificationHost().append(el);
    if (level !== 'error') setTimeout(() => close(), actions.length ? 15000 : 5000);
  });
}

const progressEls = new Map<number, { el: HTMLElement; msg: HTMLElement; bar: HTMLElement }>();

export function progress(id: number, phase: 'start' | 'report' | 'end', title?: string, message?: string, percent?: number): void {
  if (phase === 'start') {
    const msg = h('div.notif-msg.muted');
    const bar = h('div.progress-fill');
    const el = h(
      'div.notif.progress',
      null,
      icon('loading', 'notif-icon spin'),
      h('div.notif-body', null, h('div.notif-title', null, title ?? 'Working…'), msg, h('div.progress-track', null, bar)),
      h('button.btn.secondary.small', { onclick: () => void invoke('progress.cancel', id) }, 'Cancel'),
    );
    bar.classList.add('indeterminate');
    notificationHost().append(el);
    progressEls.set(id, { el, msg, bar });
    return;
  }
  const p = progressEls.get(id);
  if (!p) return;
  if (phase === 'end') {
    p.el.remove();
    progressEls.delete(id);
    return;
  }
  if (message !== undefined) p.msg.textContent = message;
  if (percent !== undefined) {
    p.bar.classList.remove('indeterminate');
    p.bar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
  }
}

export async function handleRpc(id: number, req: RpcRequest): Promise<void> {
  let value: unknown;
  switch (req.kind) {
    case 'toast':
      value = (await notify(req.level, req.message, req.actions)) ?? null;
      break;
    case 'pick':
      value = await quickPick(req.title, req.items, req.many, req.placeholder);
      break;
    case 'input':
      value = await inputBox(req);
      break;
  }
  await invoke('rpc.reply', id, value);
}
