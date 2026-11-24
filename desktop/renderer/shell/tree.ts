import type { Command, Node, TreeNode } from '../../shared/ipc';
import { contextMenu, h, icon, iconButton, MenuItem } from '../../../webview-ui/common/dom';
import { invoke } from './api';

const COLOR: Record<string, string> = {
  'charts.red': 'var(--vscode-charts-red)',
  'charts.orange': 'var(--vscode-charts-orange)',
  'charts.yellow': 'var(--vscode-charts-yellow)',
  'charts.green': 'var(--vscode-charts-green)',
  'charts.blue': 'var(--vscode-charts-blue)',
  'charts.purple': 'var(--vscode-charts-purple)',
  yellow: 'var(--vscode-charts-yellow)',
};

function key(n: Node): string {
  return [n.kind, n.connId, n.db ?? '', n.table ?? '', n.folder ?? '', n.name ?? ''].join('|');
}

export interface TreeActions {
  openTable(n: Node): void;
}

/** Lazy-loading connections tree with filter, context menus and drag & drop. */
export class ConnectionTree {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly filter: HTMLInputElement;
  private roots: TreeNode[] = [];
  private readonly children = new Map<string, TreeNode[]>();
  private readonly expanded = new Set<string>();
  private readonly loading = new Set<string>();
  private selected = '';
  private dragId: string | null = null;

  constructor(private readonly actions: TreeActions) {
    this.filter = h('input.tree-filter', { type: 'text', placeholder: 'Filter', spellcheck: false });
    this.filter.addEventListener('input', () => this.render());
    this.body = h('div.tree-body', { tabIndex: 0, role: 'tree' });
    this.el = h(
      'div.sidebar',
      null,
      h(
        'div.sidebar-head',
        null,
        h('span.sidebar-title', null, 'CONNECTIONS'),
        h('span.spacer'),
        iconButton('add', 'New connection', () => void invoke('cmd', 'newConnection')),
        iconButton('new-file', 'New query', () => void invoke('cmd', 'newQuery')),
        iconButton('refresh', 'Refresh', () => void invoke('cmd', 'refresh')),
        iconButton('history', 'Query history', () => void invoke('cmd', 'history')),
        iconButton('collapse-all', 'Collapse all', () => {
          this.expanded.clear();
          this.render();
        }),
      ),
      h('div.tree-filter-wrap', null, icon('filter'), this.filter),
      this.body,
    );
    this.body.addEventListener('keydown', (e) => this.onKey(e));
  }

  async reloadRoots(): Promise<void> {
    this.roots = await invoke('tree.roots');
    this.render();
  }

  /** Re-fetches expanded nodes of one connection (or all). */
  async refresh(connId?: string): Promise<void> {
    const wasConnected = new Map(this.roots.map((r) => [r.connId, !!r.connected]));
    this.roots = await invoke('tree.roots');
    const affected = (k: string) => !connId || k.split('|')[1] === connId;
    for (const r of this.roots) {
      const k = key(r);
      if (!affected(k) || r.connected) continue;
      if (wasConnected.get(r.connId)) {
        // Disconnected: collapse and forget its children.
        this.expanded.delete(k);
        for (const c of [...this.children.keys()]) if (c.split('|')[1] === r.connId) this.children.delete(c);
      }
      // A failed connect keeps its error node; re-fetching would reconnect.
    }
    const keys = [...this.children.keys()].filter((k) => affected(k) && this.roots.find((r) => r.connId === k.split('|')[1])?.connected);
    for (const k of keys) this.children.delete(k);
    const reloadUnder = async (nodes: TreeNode[]) => {
      for (const n of nodes) {
        const k = key(n);
        if (this.expanded.has(k) && n.expandable && (!connId || n.connId === connId) && !this.children.has(k)) {
          if (n.kind === 'connection' && !n.connected) continue;
          const kids = await invoke('tree.children', n);
          this.children.set(k, kids);
          await reloadUnder(kids);
        }
      }
    };
    this.render();
    await reloadUnder(this.roots);
    this.render();
  }

  /** Connects (errors show as a notification), then expands the connection. */
  private async connect(n: TreeNode): Promise<void> {
    const k = key(n);
    this.children.delete(k);
    this.expanded.delete(k);
    await invoke('cmd', 'connect', n);
    this.roots = await invoke('tree.roots');
    const now = this.roots.find((r) => r.connId === n.connId);
    if (now?.connected) await this.toggle(now);
    else this.render();
  }

  private async toggle(n: TreeNode): Promise<void> {
    const k = key(n);
    if (this.expanded.has(k)) {
      this.expanded.delete(k);
      this.render();
      return;
    }
    this.expanded.add(k);
    if (!this.children.has(k)) {
      this.loading.add(k);
      this.render();
      try {
        this.children.set(k, await invoke('tree.children', n));
      } finally {
        this.loading.delete(k);
      }
      if (n.kind === 'connection') this.roots = await invoke('tree.roots');
    }
    this.render();
  }

  private matches(n: TreeNode, q: string): boolean {
    if (!q) return true;
    if (n.text.toLowerCase().includes(q)) return true;
    const kids = this.children.get(key(n));
    return !!kids?.some((c) => this.matches(c, q));
  }

  private render(): void {
    const q = this.filter.value.trim().toLowerCase();
    const rows: HTMLElement[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const n of nodes) {
        if (q && n.kind !== 'connection' && n.kind !== 'database' && n.kind !== 'folder' && !this.matches(n, q)) continue;
        if (q && (n.kind === 'database' || n.kind === 'folder') && this.children.has(key(n)) && !this.matches(n, q)) continue;
        const k = key(n);
        const open = this.expanded.has(k);
        rows.push(this.row(n, depth, open));
        if (open) {
          if (this.loading.has(k)) {
            rows.push(h('div.tree-row.muted', { style: { paddingLeft: `${(depth + 1) * 14 + 22}px` } }, icon('loading', 'spin'), ' Loading…'));
          } else {
            walk(this.children.get(k) ?? [], depth + 1);
          }
        }
      }
    };
    walk(this.roots, 0);
    if (!this.roots.length) {
      rows.push(
        h(
          'div.tree-empty',
          null,
          h('p', null, 'No connections yet.'),
          h('button.btn', { onclick: () => void invoke('cmd', 'newConnection') }, icon('add'), 'Add Connection'),
          h('button.btn.secondary', { onclick: () => void invoke('cmd', 'importConnections') }, icon('cloud-download'), 'Import Connections'),
        ),
      );
    }
    this.body.replaceChildren(...rows);
  }

  private row(n: TreeNode, depth: number, open: boolean): HTMLElement {
    const k = key(n);
    const twistie = n.expandable ? icon(open ? 'chevron-down' : 'chevron-right', 'twistie') : h('span.twistie');
    const ic = icon(n.icon, n.error ? 'err' : '');
    if (n.color && COLOR[n.color]) ic.style.color = COLOR[n.color];
    const inline: HTMLElement[] = [];
    if (n.kind === 'connection') {
      inline.push(iconButton('new-file', 'New query', () => void invoke('cmd', 'newQuery', n)));
      inline.push(n.connected ? iconButton('debug-disconnect', 'Disconnect', () => void invoke('cmd', 'disconnect', n)) : iconButton('plug', 'Connect', () => void this.connect(n)));
    } else if (n.kind === 'database') {
      inline.push(iconButton('new-file', 'New query', () => void invoke('cmd', 'newQuery', n)));
    } else if (n.kind === 'table' || n.kind === 'view') {
      inline.push(iconButton('table', 'Open data', () => this.actions.openTable(n)));
    }
    const row = h(
      'div',
      {
        class: `tree-row ${this.selected === k ? 'selected' : ''} k-${n.kind}`,
        style: { paddingLeft: `${depth * 14 + 4}px` },
        title: n.tooltip ?? n.description ?? n.text,
        draggable: n.kind === 'connection',
        dataset: { key: k },
      },
      twistie,
      ic,
      h('span.tree-label', null, n.text),
      n.description ? h('span.tree-desc', null, n.description) : null,
      h('span.tree-inline', null, inline),
    );
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.tree-inline')) return;
      this.selected = k;
      if (n.kind === 'table' || n.kind === 'view') {
        this.actions.openTable(n);
        this.render();
      } else if (n.kind === 'procedure' || n.kind === 'function' || n.kind === 'trigger') {
        void invoke('cmd', 'showDdl', n);
        this.render();
      } else if (n.expandable) {
        void this.toggle(n);
      } else {
        this.render();
      }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.selected = k;
      this.render();
      const items = this.menu(n);
      if (items.length) contextMenu(e.clientX, e.clientY, items);
    });
    if (n.kind === 'connection') {
      row.addEventListener('dragstart', (e) => {
        this.dragId = n.connId;
        e.dataTransfer?.setData('text/plain', n.connId);
      });
      row.addEventListener('dragover', (e) => {
        if (this.dragId && this.dragId !== n.connId) {
          e.preventDefault();
          row.classList.add('drop-target');
        }
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        if (!this.dragId) return;
        const ids = this.roots.map((r) => r.connId).filter((id) => id !== this.dragId);
        ids.splice(ids.indexOf(n.connId), 0, this.dragId);
        this.dragId = null;
        void invoke('tree.reorder', ids);
      });
    }
    return row;
  }

  private menu(n: TreeNode): (MenuItem | null)[] {
    const c = (label: string, cmd: Command, ic?: string) => ({ label, icon: ic, run: () => void invoke('cmd', cmd, n) });
    switch (n.kind) {
      case 'connection':
        return [
          n.connected ? c('Disconnect', 'disconnect', 'debug-disconnect') : { label: 'Connect', icon: 'plug', run: () => void this.connect(n) },
          c('New Query', 'newQuery', 'new-file'),
          c('Refresh', 'refresh', 'refresh'),
          null,
          c('Edit Connection…', 'editConnection', 'edit'),
          c('Duplicate Connection', 'duplicateConnection', 'copy'),
          c('Create Database…', 'createDatabase', 'add'),
          c('Import SQL File…', 'importSql', 'cloud-download'),
          null,
          c('Delete Connection…', 'deleteConnection', 'trash'),
        ];
      case 'database':
        return [
          c('New Query', 'newQuery', 'new-file'),
          c('Refresh', 'refresh', 'refresh'),
          null,
          c('Export Database (SQL Dump)…', 'exportDatabase', 'cloud-upload'),
          c('Import SQL File…', 'importSql', 'cloud-download'),
          c('Import Data (CSV, JSON, Excel)…', 'importData', 'table'),
          null,
          c('Copy Name', 'copyName', 'copy'),
          c('Drop Database…', 'dropDatabase', 'trash'),
        ];
      case 'table':
      case 'view': {
        const items: (MenuItem | null)[] = [
          { label: 'Open Data', icon: 'table', run: () => this.actions.openTable(n) },
          c('Show DDL', 'showDdl', 'code'),
          null,
          c('Generate SELECT', 'generateSelect'),
        ];
        if (n.kind === 'table') items.push(c('Generate INSERT', 'generateInsert'), c('Generate UPDATE', 'generateUpdate'));
        items.push(null, c('Export Data…', 'exportTable', 'cloud-upload'));
        if (n.kind === 'table') items.push(c('Import Data…', 'importData', 'cloud-download'));
        items.push(null, c('Copy Name', 'copyName', 'copy'));
        if (n.kind === 'table') items.push(c('Truncate…', 'truncateTable', 'clear-all'));
        items.push(c('Drop…', 'dropObject', 'trash'));
        return items;
      }
      case 'procedure':
      case 'function':
      case 'trigger':
        return [c('Show Definition', 'showDdl', 'code'), c('Copy Name', 'copyName', 'copy'), null, c('Drop…', 'dropObject', 'trash')];
      case 'column':
        return [c('Copy Name', 'copyName', 'copy')];
      case 'folder':
        return [c('Refresh', 'refresh', 'refresh')];
      default:
        return [];
    }
  }

  private onKey(e: KeyboardEvent): void {
    const rows = [...this.body.querySelectorAll<HTMLElement>('.tree-row[data-key]')];
    const i = rows.findIndex((r) => r.dataset.key === this.selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        this.selected = next.dataset.key!;
        this.render();
        this.body.querySelector('.tree-row.selected')?.scrollIntoView({ block: 'nearest' });
      }
    } else if ((e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') && i >= 0) {
      e.preventDefault();
      rows[i].click();
    }
  }
}
