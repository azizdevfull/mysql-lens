import './shell.css';
import type * as Monaco from 'monaco-editor';
import type { ConnSummary, Node, ShellEvent, ViewSpec } from '../../shared/ipc';
import type { SchemaInfo } from '../../../src/shared/protocol';
import { contextMenu, h, icon, iconButton } from '../../../webview-ui/common/dom';
import { invoke, onEvent, uid } from './api';
import { handleRpc, notify, progress } from './dialogs';
import { ConnectionTree } from './tree';
import { SqlTab } from './sqltab';
import { registerSqlCompletion } from './completion';

declare const monaco: typeof Monaco;
declare const require: { config(c: unknown): void; (deps: string[], cb: () => void): void };

/* ------------------------------------------------------------------ */
/* Tabs                                                                 */
/* ------------------------------------------------------------------ */

type TabKind = 'welcome' | 'table' | 'sql' | 'form' | 'import';

interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  icon: string;
  key?: string;
  dirty?: boolean;
  el: HTMLElement;
  viewId?: string;
  sql?: SqlTab;
  binding?: { connId: string; db?: string };
}

const tabs: Tab[] = [];
let active: Tab | undefined;
let connections: ConnSummary[] = [];
let queryCounter = 1;

const tabBar = h('div.tabbar-tabs', { role: 'tablist' });
const content = h('div.content-area');
const statusLeft = h('span.status-item');
const statusMsg = h('span.status-item.muted');
const sidebarResizer = h('div.vsplit');

function connName(id: string): string | undefined {
  return connections.find((c) => c.id === id)?.name;
}

function renderTabs(): void {
  tabBar.replaceChildren(
    ...tabs.map((t) => {
      const el = h(
        'div',
        { class: `tab ${t === active ? 'active' : ''} ${t.dirty ? 'dirty' : ''}`, title: t.title, role: 'tab' },
        icon(t.icon, 'tab-icon'),
        h('span.tab-title', null, t.title),
        h('button.tab-close', { title: 'Close (Ctrl+W)', onclick: (e: MouseEvent) => (e.stopPropagation(), void closeTab(t)) }, icon(t.dirty ? 'circle-filled' : 'close')),
      );
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(t);
        } else if (e.button === 0) {
          activate(t);
        }
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Close', run: () => void closeTab(t) },
          { label: 'Close Others', run: () => tabs.filter((x) => x !== t).forEach((x) => void closeTab(x)) },
          { label: 'Close All', run: () => [...tabs].forEach((x) => void closeTab(x)) },
        ]);
      });
      return el;
    }),
  );
  tabBar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function activate(t: Tab): void {
  active = t;
  for (const x of tabs) x.el.hidden = x !== t;
  if (!content.contains(t.el)) content.append(t.el);
  renderTabs();
  updateStatus();
  t.sql?.focus();
  if (t.viewId) (t.el as HTMLIFrameElement).focus?.();
}

function addTab(t: Tab): Tab {
  tabs.push(t);
  content.append(t.el);
  welcomeTab && welcomeTab !== t && tabs.includes(welcomeTab) && tabs.length > 1 && void closeTab(welcomeTab, true);
  activate(t);
  return t;
}

async function closeTab(t: Tab, silent = false): Promise<void> {
  if (!silent && t.sql?.isDirty) {
    const r = await notify('warn', `"${t.title}" has unsaved changes.`, ['Save', "Don't Save"]);
    if (r === 'Save') await t.sql.save();
    else if (r !== "Don't Save") return;
  }
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  t.el.remove();
  if (t.viewId) void invoke('view.close', t.viewId);
  t.sql?.dispose();
  if (active === t) {
    active = undefined;
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) activate(next);
  }
  if (!tabs.length) showWelcome();
  renderTabs();
  updateStatus();
}

function viewTab(kind: TabKind, title: string, ic: string, spec: ViewSpec, page: 'grid' | 'connection' | 'importer', key?: string): Tab {
  const existing = key ? tabs.find((t) => t.key === key) : undefined;
  if (existing) {
    activate(existing);
    return existing;
  }
  const viewId = uid(kind);
  void invoke('view.open', viewId, spec);
  const el = h('iframe.view-frame', { src: `app://lens/views/${page}.html?view=${encodeURIComponent(viewId)}` });
  return addTab({ id: viewId, kind, title, icon: ic, key, el, viewId, binding: 'connId' in spec ? { connId: spec.connId, db: 'db' in spec ? spec.db : undefined } : undefined });
}

function openTable(connId: string, db: string, table: string, isView: boolean): void {
  viewTab('table', table, isView ? 'eye' : 'table', { kind: 'table', connId, db, table, isView }, 'grid', `table|${connId}|${db}|${table}`);
}

function openSql(opts: { text?: string; connId?: string; db?: string; title?: string; path?: string }): void {
  if (opts.path) {
    const existing = tabs.find((t) => t.sql?.path === opts.path);
    if (existing) return activate(existing);
  }
  const id = uid('sql');
  const tab: Tab = { id, kind: 'sql', title: opts.title ?? `Query ${queryCounter++}`, icon: 'file-code', el: h('div') };
  const sql = new SqlTab(
    id,
    { text: opts.text ?? '', binding: opts.connId ? { connId: opts.connId, db: opts.db } : undefined, path: opts.path },
    {
      title: (title) => {
        tab.title = title;
        renderTabs();
      },
      dirty: (d) => {
        if (tab.dirty !== d) {
          tab.dirty = d;
          renderTabs();
        }
      },
      binding: () => updateStatus(),
    },
    connName,
  );
  tab.sql = sql;
  tab.el = sql.el;
  addTab(tab);
}

/* ------------------------------------------------------------------ */
/* Welcome                                                              */
/* ------------------------------------------------------------------ */

let welcomeTab: Tab | undefined;

function showWelcome(): void {
  const recent = connections.slice(0, 8);
  const el = h(
    'div.welcome',
    null,
    h(
      'div.welcome-inner',
      null,
      h('div.welcome-logo', null, icon('database')),
      h('h1', null, 'MySQL Lens'),
      h('p.muted', null, 'MySQL & MariaDB client · unlimited connections'),
      h(
        'div.welcome-actions',
        null,
        h('button.btn', { onclick: () => void invoke('cmd', 'newConnection') }, icon('add'), 'New Connection'),
        h('button.btn.secondary', { onclick: () => void invoke('cmd', 'newQuery') }, icon('new-file'), 'New Query'),
        h('button.btn.secondary', { onclick: () => void openFile() }, icon('folder-opened'), 'Open SQL File'),
        h('button.btn.secondary', { onclick: () => void invoke('cmd', 'importConnections') }, icon('cloud-download'), 'Import Connections'),
      ),
      recent.length
        ? h(
            'div.welcome-recent',
            null,
            h('h3', null, 'Connections'),
            recent.map((c) =>
              h(
                'button.recent',
                { onclick: () => void invoke('cmd', 'newQuery', { kind: 'connection', connId: c.id, db: c.database } as Node) },
                icon(c.connected ? 'database' : 'circle-large-outline'),
                h('span.recent-name', null, c.name),
                h('span.muted', null, c.description),
              ),
            ),
          )
        : null,
      h(
        'div.welcome-keys',
        null,
        ...[
          ['Ctrl+N', 'New query'],
          ['Ctrl+Enter', 'Run statement'],
          ['Ctrl+Shift+Enter', 'Run all'],
          ['Ctrl+Space', 'Suggestions'],
          ['Ctrl+B', 'Toggle sidebar'],
          ['Ctrl+H', 'Query history'],
        ].map(([k, d]) => h('div.key-row', null, h('kbd', null, k), h('span.muted', null, d))),
      ),
    ),
  );
  if (welcomeTab && tabs.includes(welcomeTab)) {
    welcomeTab.el.replaceWith(el);
    welcomeTab.el = el;
    if (active === welcomeTab) el.hidden = false;
    return;
  }
  welcomeTab = { id: 'welcome', kind: 'welcome', title: 'Welcome', icon: 'home', el };
  tabs.push(welcomeTab);
  content.append(el);
  activate(welcomeTab);
}

/* ------------------------------------------------------------------ */
/* Status bar                                                           */
/* ------------------------------------------------------------------ */

function updateStatus(): void {
  const b = active?.sql?.binding ?? active?.binding;
  const c = b ? connections.find((x) => x.id === b.connId) : undefined;
  statusLeft.replaceChildren(
    c ? icon(c.connected ? 'database' : 'circle-large-outline') : icon('plug'),
    document.createTextNode(c ? ` ${c.name}${b?.db ? ' › ' + b.db : ''}${c.readOnly ? ' · read-only' : ''}` : ' No connection'),
  );
  statusLeft.className = `status-item ${c?.connected ? 'on' : ''}`;
  statusLeft.style.cursor = active?.sql ? 'pointer' : 'default';
  statusLeft.onclick = () => void active?.sql?.pickBinding();
}

let statusTimer = 0;
function status(msg: string): void {
  statusMsg.replaceChildren(icon('check'), ` ${msg}`);
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => statusMsg.replaceChildren(), 2500);
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

async function openFile(): Promise<void> {
  const f = await invoke('file.open');
  if (f) openSql({ text: f.text, path: f.path, title: f.path.split(/[\\/]/).pop() });
}

async function reloadConnections(): Promise<void> {
  connections = await invoke('conn.list');
  for (const t of tabs) t.sql?.renderBinding();
  updateStatus();
  if (welcomeTab && tabs.includes(welcomeTab)) showWelcome();
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

const tree = new ConnectionTree({ openTable: (n) => openTable(n.connId, n.db!, n.name!, n.kind === 'view') });

function initSidebarResize(sidebar: HTMLElement): void {
  sidebarResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.getBoundingClientRect().width;
    document.body.classList.add('col-resizing');
    content.style.pointerEvents = 'none';
    const move = (ev: MouseEvent) => (sidebar.style.width = `${Math.max(180, Math.min(600, startW + ev.clientX - startX))}px`);
    const up = () => {
      document.body.classList.remove('col-resizing');
      content.style.pointerEvents = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try {
        localStorage.setItem('sidebarWidth', sidebar.style.width);
      } catch {
        // ignore
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function layout(): void {
  const app = document.getElementById('app')!;
  try {
    const w = localStorage.getItem('sidebarWidth');
    if (w) tree.el.style.width = w;
  } catch {
    // ignore
  }
  initSidebarResize(tree.el);
  app.replaceChildren(
    h(
      'div.shell',
      null,
      h('div.shell-main', null, tree.el, sidebarResizer, h('div.editor-area', null, h('div.tabbar', null, tabBar, h('div.tabbar-actions', null, iconButton('new-file', 'New query (Ctrl+N)', () => void invoke('cmd', 'newQuery')))), content)),
      h('div.statusbar', null, statusLeft, h('span.spacer'), statusMsg, h('span.status-item.muted', null, 'MySQL Lens')),
    ),
  );
}

function handleEvent(ev: ShellEvent): void {
  switch (ev.type) {
    case 'rpc':
      void handleRpc(ev.id, ev.req);
      break;
    case 'progress':
      progress(ev.id, ev.phase, ev.title, ev.message, ev.percent);
      break;
    case 'status':
      status(ev.message);
      break;
    case 'treeChanged':
      schemaCache.clear();
      void tree.refresh(ev.connId);
      void reloadConnections();
      break;
    case 'connections':
      void tree.reloadRoots();
      void reloadConnections();
      break;
    case 'openTable':
      openTable(ev.connId, ev.db, ev.table, ev.isView);
      break;
    case 'openForm':
      viewTab('form', ev.id ? 'Edit Connection' : 'New Connection', 'plug', { kind: 'form', id: ev.id, copyOf: ev.copyOf }, 'connection', ev.id ? `form|${ev.id}` : undefined);
      break;
    case 'openImport':
      viewTab('import', `Import into ${ev.db}`, 'cloud-download', { kind: 'import', connId: ev.connId, db: ev.db, table: ev.table }, 'importer');
      break;
    case 'openSql':
      openSql({ text: ev.text, connId: ev.connId, db: ev.db, title: ev.title, path: ev.path });
      break;
    case 'closeView': {
      const t = tabs.find((x) => x.viewId === ev.viewId);
      if (t) void closeTab(t, true);
      break;
    }
    case 'setTitle': {
      const t = tabs.find((x) => x.viewId === ev.viewId);
      if (t) {
        t.title = ev.title;
        renderTabs();
      }
      break;
    }
    case 'sqlBinding': {
      const t = tabs.find((x) => x.sql?.tabId === ev.tabId);
      t?.sql?.setBinding({ connId: ev.connId, db: ev.db });
      break;
    }
    case 'theme':
      monaco?.editor.setTheme(ev.theme === 'light' ? 'vs' : 'vs-dark');
      break;
    case 'refreshTables':
      break;
  }
}

/* Schema cache for autocomplete. */
const schemaCache = new Map<string, Promise<SchemaInfo | null>>();
function schemaFor(model: Monaco.editor.ITextModel): Promise<SchemaInfo | null> {
  const tab = (model as unknown as { __tab?: SqlTab }).__tab;
  const b = tab?.binding;
  if (!b?.db) return Promise.resolve(null);
  const key = `${b.connId}|${b.db}`;
  let p = schemaCache.get(key);
  if (!p) {
    p = invoke('sql.schema', b.connId, b.db);
    schemaCache.set(key, p);
  }
  return p;
}

function loadMonaco(): Promise<void> {
  return new Promise((resolve) => {
    require.config({ paths: { vs: 'app://lens/vs' } });
    require(['vs/editor/editor.main'], () => resolve());
  });
}

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Tab' && tabs.length > 1) {
    e.preventDefault();
    const i = active ? tabs.indexOf(active) : 0;
    activate(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
  }
});

window.lens.onMenu((action) => {
  switch (action) {
    case 'newQuery':
      void invoke('cmd', 'newQuery', active?.sql?.binding ? ({ kind: 'database', connId: active.sql.binding.connId, db: active.sql.binding.db } as Node) : undefined);
      break;
    case 'openFile':
      void openFile();
      break;
    case 'save':
      void active?.sql?.save();
      break;
    case 'closeTab':
      if (active) void closeTab(active);
      break;
    case 'toggleSidebar':
      tree.el.hidden = !tree.el.hidden;
      sidebarResizer.hidden = tree.el.hidden;
      break;
  }
});

async function boot(): Promise<void> {
  layout();
  onEvent(handleEvent);
  await loadMonaco();
  const dark = !window.matchMedia('(prefers-color-scheme: light)').matches;
  monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
  registerSqlCompletion(monaco, schemaFor);
  await reloadConnections();
  await tree.reloadRoots();
  showWelcome();
}

void boot();
