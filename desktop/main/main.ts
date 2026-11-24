import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, net, protocol, shell, WebFrameMain } from 'electron';
import * as mysql from 'mysql2';
import { ConnectionManager } from '../../src/connections/manager';
import { describe } from '../../src/connections/types';
import { SchemaService } from '../../src/schema';
import { errorText } from '../../src/core/errors';
import * as flows from '../../src/core/flows';
import { ResultsController, TableController } from '../../src/core/gridControllers';
import { ConnectionFormController } from '../../src/core/formController';
import { ImportController } from '../../src/core/importController';
import { FOLDER_LABEL, Node, treeChildren } from '../../src/core/treeModel';
import { riskyStatements } from '../../src/core/sqlSafety';
import type { Api, Command, ConnSummary, ShellEvent, TreeNode, ViewSpec } from '../shared/ipc';
import { DesktopHost } from './host';
import { DesktopStore, JsonFile } from './store';

const DIST = __dirname;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let win: BrowserWindow | undefined;
const host = new DesktopHost(() => win);
const store = new DesktopStore();
const conns = new ConnectionManager(store, {
  askSecret: async (prompt) => {
    const v = await host.input({ title: prompt, password: true });
    if (v === undefined) throw new Error('Cancelled.');
    return v;
  },
  onTunnelClosed: (name) => void host.warn(`SSH tunnel for "${name}" closed.`),
});
const schema = new SchemaService(conns, () => host.settings().showSystemDatabases);
const fctx: flows.Ctx = { host, conns, schema, store };
const send = (ev: ShellEvent) => host.send(ev);

conns.onDidChangeState((connId) => send({ type: 'treeChanged', connId }));
store.onDidChange(() => send({ type: 'connections' }));

/* ------------------------------------------------------------------ */
/* Views hosted in iframes (grid, connection form, import wizard)       */
/* ------------------------------------------------------------------ */

interface View {
  receive(m: unknown): Promise<void> | void;
  dispose?(): void;
  frame?: WebFrameMain;
  queue: unknown[];
}

const views = new Map<string, View>();
/** Frames that registered before their view was opened (IPC from two senders can interleave). */
const earlyFrames = new Map<string, WebFrameMain>();

function poster(viewId: string) {
  return (m: unknown) => {
    const v = views.get(viewId);
    if (!v) return;
    if (v.frame && !v.frame.isDestroyed()) v.frame.send('view:msg', m);
    else v.queue.push(m);
  };
}

const tableControllers = new Map<string, TableController>();

function openView(viewId: string, spec: ViewSpec): void {
  views.get(viewId)?.dispose?.();
  const post = poster(viewId);
  const view: View = { queue: [], receive: () => undefined, frame: earlyFrames.get(viewId) };
  earlyFrames.delete(viewId);
  views.set(viewId, view);
  switch (spec.kind) {
    case 'table': {
      const c = new TableController(host, post, conns, schema, spec.connId, spec.db, spec.table, spec.isView);
      tableControllers.set(viewId, c);
      view.receive = (m) => c.receive(m as never);
      view.dispose = () => {
        tableControllers.delete(viewId);
        c.dispose();
      };
      break;
    }
    case 'results': {
      const tab = sqlTab(spec.tabId);
      const c = new ResultsController(host, post, conns, () => void rerun(spec.tabId));
      tab.results = c;
      view.receive = (m) => c.receive(m as never);
      view.dispose = () => c.dispose();
      break;
    }
    case 'form': {
      const c = new ConnectionFormController(host, post, store, conns, { id: spec.id, copyOf: spec.copyOf }, () => send({ type: 'closeView', viewId }));
      view.receive = (m) => c.receive(m as never);
      send({ type: 'setTitle', viewId, title: c.title });
      break;
    }
    case 'import': {
      const c = new ImportController(host, post, conns, schema, spec.connId, spec.db, spec.table, {
        setTitle: (title) => send({ type: 'setTitle', viewId, title }),
        close: () => send({ type: 'closeView', viewId }),
        openTable: (table) => send({ type: 'openTable', connId: spec.connId, db: spec.db, table, isView: false }),
        done: () => {
          send({ type: 'treeChanged', connId: spec.connId });
          refreshTables(spec.connId, spec.db);
        },
      });
      view.receive = (m) => c.receive(m as never);
      view.dispose = () => c.dispose();
      break;
    }
  }
}

function refreshTables(connId: string, db?: string): void {
  for (const c of tableControllers.values()) {
    if (c.connId === connId && (!db || c.db === db)) void c.load();
  }
}

ipcMain.on('view:register', (e, viewId: string) => {
  const v = views.get(viewId);
  if (!e.senderFrame) return;
  if (!v) {
    earlyFrames.set(viewId, e.senderFrame);
    return;
  }
  v.frame = e.senderFrame;
  for (const m of v.queue.splice(0)) v.frame.send('view:msg', m);
});

ipcMain.on('view:msg', (_e, viewId: string, msg: unknown) => {
  const v = views.get(viewId);
  if (v) Promise.resolve(v.receive(msg)).catch((err) => host.error(errorText(err)));
});

/* ------------------------------------------------------------------ */
/* SQL editor tabs                                                      */
/* ------------------------------------------------------------------ */

interface SqlTab {
  conn?: mysql.Connection;
  connKey?: string;
  results?: ResultsController;
  last?: { connId: string; db?: string; statements: string[] };
}

const sqlTabs = new Map<string, SqlTab>();
const history = new JsonFile<{ sql: string; connName: string; database?: string; at: number; ok: boolean; ms: number }[]>('history.json', []);
const DDL = /^\s*(create|alter|drop|rename|truncate)\b/i;

function sqlTab(id: string): SqlTab {
  let t = sqlTabs.get(id);
  if (!t) sqlTabs.set(id, (t = {}));
  return t;
}

async function runSql(tabId: string, connId: string, db: string | undefined, statements: string[]): Promise<void> {
  const tab = sqlTab(tabId);
  if (!tab.results) throw new Error('Results view is not ready yet.');
  if (tab.results.isRunning) {
    void host.warn('A query is still running in this tab.');
    return;
  }
  if (host.settings().confirmDangerousQueries) {
    const risky = riskyStatements(statements);
    if (risky.length) {
      const ok = await host.confirm('This will change or delete data and cannot be undone.', risky.map((s) => s.replace(/\s+/g, ' ').slice(0, 200)).join('\n'), 'Run Anyway');
      if (ok !== 'Run Anyway') return;
    }
  }
  const cfg = conns.config(connId);
  const key = `${connId}|${db ?? ''}`;
  if (!tab.conn || tab.connKey !== key) {
    tab.conn?.destroy();
    tab.conn = undefined;
    const conn = await conns.dedicated(connId, db);
    conn.on('error', () => tab.conn === conn && (tab.conn = undefined));
    conn.on('end', () => tab.conn === conn && (tab.conn = undefined));
    tab.conn = conn;
    tab.connKey = key;
  }
  tab.last = { connId, db, statements };
  let ddl = false;
  let currentDb = db;
  await tab.results.run({ connId, connName: cfg.name, database: db, conn: tab.conn, readOnly: cfg.readOnly }, statements, (sql, ok, ms) => {
    const list = history.read().filter((h) => !(h.sql === sql && h.connName === cfg.name));
    list.unshift({ sql, connName: cfg.name, database: currentDb, at: Date.now(), ok, ms });
    history.write(list.slice(0, host.settings().historySize));
    if (ok && DDL.test(sql)) ddl = true;
    const use = /^\s*use\s+`?([^`;\s]+)`?/i.exec(sql);
    if (ok && use) {
      currentDb = use[1];
      tab.connKey = `${connId}|${currentDb}`;
      tab.last = { connId, db: currentDb, statements };
      send({ type: 'sqlBinding', tabId, connId, db: currentDb });
    }
  });
  if (ddl) {
    schema.invalidate(connId);
    send({ type: 'treeChanged', connId });
  }
}

async function rerun(tabId: string): Promise<void> {
  const t = sqlTabs.get(tabId);
  if (t?.last) await runSql(tabId, t.last.connId, t.last.db, t.last.statements);
}

async function pickBinding(connId?: string): Promise<{ connId: string; db?: string } | null> {
  if (!connId) {
    const list = store.list();
    if (!list.length) {
      send({ type: 'openForm' });
      return null;
    }
    const picked = await host.pick(
      list.map((c) => ({ label: c.name, description: `${c.user}@${c.host}:${c.port}`, detail: conns.isConnected(c.id) ? 'connected' : undefined, id: c.id })),
      { title: 'Select connection' },
    );
    if (!picked) return null;
    connId = picked.id;
  }
  const dbs = await schema.databases(connId);
  const def = store.get(connId)?.database;
  const picked = await host.pick(
    [{ label: 'No default database', db: '' }, ...dbs.map((d) => ({ label: d, description: d === def ? 'default' : undefined, db: d }))],
    { title: 'Select database', placeholder: 'Database used for unqualified table names' },
  );
  if (!picked) return null;
  return { connId, db: picked.db || undefined };
}

/* ------------------------------------------------------------------ */
/* Tree                                                                 */
/* ------------------------------------------------------------------ */

const FOLDER_ICON: Record<string, string> = { tables: 'folder', views: 'folder', procedures: 'symbol-method', functions: 'symbol-function', triggers: 'zap', indexes: 'list-tree' };

function toTreeNode(n: Node): TreeNode {
  switch (n.kind) {
    case 'database':
      return { ...n, text: n.db!, icon: 'database', expandable: true };
    case 'folder':
      return { ...n, text: n.label ?? FOLDER_LABEL[n.folder!], icon: FOLDER_ICON[n.folder!] ?? 'folder', expandable: true };
    case 'table':
    case 'view':
      return { ...n, text: n.name!, icon: n.kind === 'view' ? 'eye' : 'table', expandable: true };
    case 'column':
      return { ...n, text: n.name!, icon: n.pk ? 'key' : 'symbol-field', color: n.pk ? 'yellow' : undefined, expandable: false };
    case 'index':
      return { ...n, text: n.name!, icon: 'symbol-key', expandable: false };
    case 'procedure':
    case 'function':
    case 'trigger':
      return { ...n, text: n.name!, icon: n.kind === 'trigger' ? 'zap' : n.kind === 'function' ? 'symbol-function' : 'symbol-method', expandable: false };
    default:
      return { ...n, text: n.label ?? '', icon: n.description === 'error' ? 'error' : 'info', expandable: false, error: n.description === 'error', description: undefined };
  }
}

function connSummaries(): ConnSummary[] {
  return store.list().map((c) => ({ id: c.id, name: c.name, color: c.color, connected: conns.isConnected(c.id), database: c.database || undefined, readOnly: c.readOnly, description: describe(c) }));
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

async function runCommand(name: Command, n?: Node): Promise<void> {
  const changed = (connId?: string) => send({ type: 'treeChanged', connId });
  switch (name) {
    case 'connect':
      await conns.connect(n!.connId);
      return;
    case 'disconnect':
      await conns.disconnect(n!.connId);
      return;
    case 'refresh':
      if (n?.connId) schema.invalidate(n.connId, n.db);
      else store.list().forEach((c) => schema.invalidate(c.id));
      changed(n?.connId);
      return;
    case 'newConnection':
      send({ type: 'openForm' });
      return;
    case 'editConnection':
      send({ type: 'openForm', id: n!.connId });
      return;
    case 'duplicateConnection':
      send({ type: 'openForm', copyOf: n!.connId });
      return;
    case 'deleteConnection':
      await flows.deleteConnection(fctx, n!.connId);
      return;
    case 'createDatabase':
      if (await flows.createDatabase(fctx, n!.connId)) changed(n!.connId);
      return;
    case 'dropDatabase':
      if (await flows.dropDatabase(fctx, n!.connId, n!.db!)) changed(n!.connId);
      return;
    case 'exportDatabase':
      await flows.exportDatabase(fctx, n!.connId, n!.db!);
      return;
    case 'importSql':
      if (await flows.importSql(fctx, n!.connId, n!.db)) changed(n!.connId);
      return;
    case 'importData':
      send({ type: 'openImport', connId: n!.connId, db: n!.db!, table: n!.kind === 'table' ? n!.name : undefined });
      return;
    case 'openTable':
      send({ type: 'openTable', connId: n!.connId, db: n!.db!, table: n!.name!, isView: n!.kind === 'view' });
      return;
    case 'showDdl': {
      const sql = await schema.createStatement(n!.connId, n!.db!, n!.kind, n!.name!);
      send({ type: 'openSql', text: (sql || `-- No definition available for ${n!.name}`) + ';\n', language: 'sql', connId: n!.connId, db: n!.db, title: n!.name });
      return;
    }
    case 'generateSelect':
    case 'generateInsert':
    case 'generateUpdate': {
      const kind = name === 'generateSelect' ? 'select' : name === 'generateInsert' ? 'insert' : 'update';
      send({ type: 'openSql', text: await flows.sqlTemplate(fctx, kind, n!.connId, n!.db!, n!.name!), language: 'sql', connId: n!.connId, db: n!.db });
      return;
    }
    case 'copyName':
      await host.copy(n!.kind === 'database' ? n!.db! : n!.name!);
      return;
    case 'exportTable':
      await flows.exportTable(fctx, n!.connId, n!.db!, n!.name!);
      return;
    case 'truncateTable':
      if (await flows.truncateTable(fctx, n!.connId, n!.db!, n!.name!)) {
        changed(n!.connId);
        refreshTables(n!.connId, n!.db);
      }
      return;
    case 'dropObject':
      if (await flows.dropObject(fctx, n!.kind, n!.connId, n!.db!, n!.name!)) changed(n!.connId);
      return;
    case 'newQuery': {
      if (n?.connId) {
        send({ type: 'openSql', text: '', language: 'sql', connId: n.connId, db: n.db ?? store.get(n.connId)?.database ?? undefined });
      } else {
        const b = await pickBinding();
        if (b) send({ type: 'openSql', text: '', language: 'sql', connId: b.connId, db: b.db });
      }
      return;
    }
    case 'exportConnections':
      await flows.exportConnections(fctx);
      return;
    case 'importConnections':
      await flows.importConnections(fctx);
      return;
    case 'history': {
      const list = history.read();
      if (!list.length) {
        void host.info('Query history is empty.');
        return;
      }
      const picked = await host.pick(
        list.map((h) => ({ label: `${h.ok ? '✓' : '✗'} ${h.sql.replace(/\s+/g, ' ').slice(0, 140)}`, description: `${h.connName}${h.database ? ' › ' + h.database : ''}`, detail: `${new Date(h.at).toLocaleString()} · ${h.ms} ms`, h })),
        { title: 'Query History', placeholder: 'Search executed queries' },
      );
      if (picked) send({ type: 'openSql', text: picked.h.sql.trimEnd() + ';\n', language: 'sql' });
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* IPC API                                                              */
/* ------------------------------------------------------------------ */

const api: { [K in keyof Api]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> | Promise<ReturnType<Api[K]>> } = {
  'tree.roots': () =>
    store.list().map((c) => ({
      kind: 'connection',
      connId: c.id,
      text: c.name,
      icon: conns.isConnected(c.id) ? 'database' : 'circle-large-outline',
      color: c.color,
      expandable: true,
      connected: conns.isConnected(c.id),
      description: describe(c) + (c.readOnly ? ' · read-only' : ''),
    })),
  'tree.children': async (node) => {
    try {
      return (await treeChildren(node, schema)).map(toTreeNode);
    } catch (e) {
      const msg = errorText(e);
      return [{ kind: 'message', connId: node.connId, text: msg, icon: 'error', expandable: false, error: true, tooltip: msg }];
    }
  },
  'tree.reorder': (ids) => store.reorder(ids),
  cmd: async (name, node) => {
    try {
      await runCommand(name, node);
    } catch (e) {
      host.error(errorText(e));
    }
  },
  'view.open': (viewId, spec) => openView(viewId, spec),
  'view.close': (viewId) => {
    views.get(viewId)?.dispose?.();
    views.delete(viewId);
  },
  'conn.list': () => connSummaries(),
  'conn.databases': (connId) => schema.databases(connId),
  'sql.run': async (args) => {
    try {
      await runSql(args.tabId, args.connId, args.db, args.statements);
    } catch (e) {
      host.error(errorText(e));
    }
  },
  'sql.cancel': (tabId) => sqlTabs.get(tabId)?.results?.cancel(),
  'sql.close': (tabId) => {
    const t = sqlTabs.get(tabId);
    t?.conn?.destroy();
    sqlTabs.delete(tabId);
  },
  'sql.schema': async (connId, db) => {
    try {
      const [tables, cols] = await Promise.all([schema.tables(connId, db), schema.allColumns(connId, db)]);
      return { database: db, table: '', tables: tables.map((t) => t.name), columns: Object.fromEntries(cols) };
    } catch {
      return null;
    }
  },
  'sql.pickBinding': async (_tabId, connId) => {
    try {
      return await pickBinding(connId);
    } catch (e) {
      host.error(errorText(e));
      return null;
    }
  },
  'file.open': async () => {
    const p = await host.openFile({ filters: { SQL: ['sql'], 'All files': ['*'] } });
    return p ? { path: p, text: await fs.promises.readFile(p, 'utf8') } : null;
  },
  'file.save': async (p, text) => {
    const target = p ?? (await host.saveFile({ defaultName: 'query.sql', filters: { SQL: ['sql'] } }));
    if (!target) return null;
    await fs.promises.writeFile(target, text);
    return target;
  },
  'rpc.reply': (id, value) => host.reply(id, value),
  'progress.cancel': (id) => host.cancelProgress(id),
  'settings.get': () => {
    const s = host.settings();
    return { theme: s.theme, maxRows: s.maxRows, pageSize: s.pageSize, confirmDangerousQueries: s.confirmDangerousQueries, showSystemDatabases: s.showSystemDatabases };
  },
  'settings.set': (patch) => {
    const s = host.saveSettings(patch);
    applyTheme(s.theme);
    if ('showSystemDatabases' in patch) {
      store.list().forEach((c) => schema.invalidate(c.id));
      send({ type: 'treeChanged' });
    }
  },
  'app.info': () => ({ version: app.getVersion(), platform: process.platform }),
};

ipcMain.handle('lens:invoke', (_e, name: keyof Api, ...args: unknown[]) => (api[name] as (...a: unknown[]) => unknown)(...args));

/* ------------------------------------------------------------------ */
/* Window                                                               */
/* ------------------------------------------------------------------ */

function applyTheme(theme: 'system' | 'dark' | 'light'): void {
  nativeTheme.themeSource = theme;
  send({ type: 'theme', theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' });
}

function buildMenu(): void {
  const cmd = (name: Command) => () => void runCommand(name).catch((e) => host.error(errorText(e)));
  const shellCmd = (action: string) => () => win?.webContents.send('lens:menu', action);
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Connection…', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('newConnection') },
        { label: 'New Query', accelerator: 'CmdOrCtrl+N', click: shellCmd('newQuery') },
        { label: 'Open SQL File…', accelerator: 'CmdOrCtrl+O', click: shellCmd('openFile') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: shellCmd('save') },
        { type: 'separator' },
        { label: 'Import Connections…', click: cmd('importConnections') },
        { label: 'Export Connections…', click: cmd('exportConnections') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: shellCmd('closeTab') },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Query History', accelerator: 'CmdOrCtrl+H', click: cmd('history') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: shellCmd('toggleSidebar') },
        { type: 'separator' },
        { label: 'Theme: System', type: 'radio', checked: host.settings().theme === 'system', click: () => api['settings.set']({ theme: 'system' }) },
        { label: 'Theme: Dark', type: 'radio', checked: host.settings().theme === 'dark', click: () => api['settings.set']({ theme: 'dark' }) },
        { label: 'Theme: Light', type: 'radio', checked: host.settings().theme === 'light', click: () => api['settings.set']({ theme: 'light' }) },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'GitHub Repository', click: () => void shell.openExternal('https://github.com/azizdevfull/mysql-lens') },
        { label: 'Report an Issue', click: () => void shell.openExternal('https://github.com/azizdevfull/mysql-lens/issues') },
        { label: `About MySQL Lens ${app.getVersion()}`, click: () => void host.info(`MySQL Lens ${app.getVersion()} · Electron ${process.versions.electron}`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const hidden = process.env.MYSQL_LENS_HIDDEN === '1';
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'MySQL Lens',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    icon: path.join(DIST, 'icon.png'),
    webPreferences: {
      preload: path.join(DIST, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegrationInSubFrames: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!hidden) win?.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  void win.loadURL('app://lens/index.html');
  win.on('closed', () => (win = undefined));
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  nativeTheme.themeSource = host.settings().theme;
  nativeTheme.on('updated', () => send({ type: 'theme', theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' }));
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  conns.dispose();
  for (const t of sqlTabs.values()) t.conn?.destroy();
  app.quit();
});

app.on('activate', () => {
  if (!win) createWindow();
});
