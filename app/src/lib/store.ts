import { create } from 'zustand';
import { toast } from 'sonner';
import { backend } from './backend';
import type { Column, Connection, PageRequest, Relations } from './types';

export type TabKind = 'welcome' | 'table' | 'query';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  connId?: string;
  db?: string;
  table?: string;
  isView?: boolean;
  sql?: string;
  dirty?: boolean;
  /** Table tabs: page, sort and filter, kept for session restore. */
  tableState?: PageRequest;
  /** Bumped when an already open table tab is sent to a new `tableState` (foreign key navigation). */
  nav?: number;
}

/** Current editor text of each query tab (kept out of the store so typing does not re-render). */
export const liveSql = new Map<string, string>();

/** A tab as saved in the session file. */
export type SavedTab = Pick<Tab, 'kind' | 'title' | 'connId' | 'db' | 'table' | 'isView' | 'sql' | 'tableState'>;

export type ConnState = 'off' | 'connecting' | 'on' | 'error';

interface State {
  connections: Connection[];
  connState: Record<string, ConnState>;
  connError: Record<string, string>;
  tabs: Tab[];
  active: string;
  theme: 'dark' | 'light';
  paletteOpen: boolean;
  connDialog: { open: boolean; editing?: Connection };
  schemaCache: Record<string, Record<string, Column[]>>;
  relationsCache: Record<string, Relations>;
  treeVersion: number;
  /** Reopen the previous session's tabs on startup. */
  restoreSession: boolean;

  load(): Promise<void>;
  /** Replaces the tabs with saved ones (new ids). Keeps Welcome when the list is empty. */
  restoreTabs(tabs: SavedTab[], active: number): void;
  setRestoreSession(on: boolean): void;
  connect(id: string): Promise<boolean>;
  disconnect(id: string): Promise<void>;
  /** Opens (or focuses) a table tab. With `filter`, the tab shows only the matching rows. */
  openTable(connId: string, db: string, table: string, isView?: boolean, filter?: string): void;
  openQuery(connId?: string, db?: string, sql?: string): void;
  closeTab(id: string): void;
  closeOthers(id: string): void;
  closeRight(id: string): void;
  closeAll(): void;
  setActive(id: string): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  toggleTheme(): void;
  setPalette(open: boolean): void;
  openConnDialog(editing?: Connection): void;
  closeConnDialog(): void;
  schema(connId: string, db: string): Promise<Record<string, Column[]>>;
  /** Foreign keys of a table (cached until the tree is refreshed). */
  relations(connId: string, db: string, table: string): Promise<Relations>;
  refreshTree(): void;
}

let seq = 1;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;
const welcome: Tab = { id: 'welcome', kind: 'welcome', title: 'Welcome' };

const initialTheme = (() => {
  try {
    return (localStorage.getItem('theme') as 'dark' | 'light') || 'dark';
  } catch {
    return 'dark';
  }
})();
document.documentElement.classList.toggle('dark', initialTheme === 'dark');

const initialRestore = (() => {
  try {
    return localStorage.getItem('restoreSession') !== 'off';
  } catch {
    return true;
  }
})();

export const useApp = create<State>((set, get) => ({
  connections: [],
  connState: {},
  connError: {},
  tabs: [welcome],
  active: 'welcome',
  theme: initialTheme,
  paletteOpen: false,
  connDialog: { open: false },
  schemaCache: {},
  relationsCache: {},
  treeVersion: 0,
  restoreSession: initialRestore,

  async load() {
    set({ connections: await backend.listConnections() });
  },

  restoreTabs(saved, active) {
    const tabs: Tab[] = saved.map((t) => ({ ...t, id: uid(t.kind === 'table' ? 't' : 'q') }));
    if (!tabs.length) return set({ tabs: [welcome], active: 'welcome' });
    set({ tabs, active: tabs[Math.min(Math.max(active, 0), tabs.length - 1)].id });
  },

  setRestoreSession(on) {
    try {
      localStorage.setItem('restoreSession', on ? 'on' : 'off');
    } catch {
      // ignore
    }
    set({ restoreSession: on });
  },

  async connect(id) {
    const st = get().connState[id];
    if (st === 'on') return true;
    set((s) => ({ connState: { ...s.connState, [id]: 'connecting' } }));
    try {
      await backend.connect(id);
      set((s) => ({ connState: { ...s.connState, [id]: 'on' }, connError: { ...s.connError, [id]: '' } }));
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      set((s) => ({ connState: { ...s.connState, [id]: 'error' }, connError: { ...s.connError, [id]: msg } }));
      toast.error('Could not connect', { description: msg });
      return false;
    }
  },

  async disconnect(id) {
    await backend.disconnect(id);
    set((s) => ({ connState: { ...s.connState, [id]: 'off' } }));
  },

  openTable(connId, db, table, isView, filter) {
    const tableState = filter === undefined ? undefined : { page: 0, pageSize: 200, sort: null, filter };
    const existing = get().tabs.find((t) => t.kind === 'table' && t.connId === connId && t.db === db && t.table === table);
    if (existing) {
      if (!tableState) return set({ active: existing.id });
      const state = { ...tableState, pageSize: existing.tableState?.pageSize ?? tableState.pageSize };
      return set((s) => ({ active: existing.id, tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, tableState: state, nav: (t.nav ?? 0) + 1 } : t)) }));
    }
    const tab: Tab = { id: uid('t'), kind: 'table', title: table, connId, db, table, isView, tableState };
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== 'welcome'), tab], active: tab.id }));
  },

  openQuery(connId, db, sql = '') {
    const n = get().tabs.filter((t) => t.kind === 'query').length + 1;
    const c = connId ?? get().connections.find((x) => get().connState[x.id] === 'on')?.id ?? get().connections[0]?.id;
    const tab: Tab = { id: uid('q'), kind: 'query', title: `Query ${n}`, connId: c, db: db ?? get().connections.find((x) => x.id === c)?.database, sql };
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== 'welcome'), tab], active: tab.id }));
  },

  closeTab(id) {
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (!tabs.length) return { tabs: [welcome], active: 'welcome' };
      const active = s.active === id ? tabs[Math.min(i, tabs.length - 1)].id : s.active;
      return { tabs, active };
    });
  },

  closeOthers(id) {
    set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), active: id }));
  },

  closeRight(id) {
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.slice(0, i + 1);
      return { tabs, active: tabs.some((t) => t.id === s.active) ? s.active : id };
    });
  },

  closeAll() {
    set({ tabs: [welcome], active: 'welcome' });
  },

  setActive(id) {
    set({ active: id });
  },

  updateTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },

  toggleTheme() {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // ignore
    }
    set({ theme });
  },

  setPalette(open) {
    set({ paletteOpen: open });
  },

  openConnDialog(editing) {
    set({ connDialog: { open: true, editing } });
  },

  closeConnDialog() {
    set({ connDialog: { open: false } });
  },

  async schema(connId, db) {
    const key = `${connId}|${db}`;
    const cached = get().schemaCache[key];
    if (cached) return cached;
    const s = await backend.schema(connId, db);
    set((st) => ({ schemaCache: { ...st.schemaCache, [key]: s } }));
    return s;
  },

  async relations(connId, db, table) {
    const key = `${connId}|${db}|${table}`;
    const cached = get().relationsCache[key];
    if (cached) return cached;
    const r = await backend.foreignKeys(connId, db, table);
    set((st) => ({ relationsCache: { ...st.relationsCache, [key]: r } }));
    return r;
  },

  refreshTree() {
    set((s) => ({ treeVersion: s.treeVersion + 1, schemaCache: {}, relationsCache: {} }));
  },
}));
