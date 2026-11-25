import { create } from 'zustand';
import { toast } from 'sonner';
import { backend } from './backend';
import type { Column, Connection } from './types';

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
}

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
  treeVersion: number;

  load(): Promise<void>;
  connect(id: string): Promise<boolean>;
  disconnect(id: string): Promise<void>;
  openTable(connId: string, db: string, table: string, isView?: boolean): void;
  openQuery(connId?: string, db?: string, sql?: string): void;
  closeTab(id: string): void;
  setActive(id: string): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  toggleTheme(): void;
  setPalette(open: boolean): void;
  openConnDialog(editing?: Connection): void;
  closeConnDialog(): void;
  schema(connId: string, db: string): Promise<Record<string, Column[]>>;
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
  treeVersion: 0,

  async load() {
    set({ connections: await backend.listConnections() });
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

  openTable(connId, db, table, isView) {
    const existing = get().tabs.find((t) => t.kind === 'table' && t.connId === connId && t.db === db && t.table === table);
    if (existing) return set({ active: existing.id });
    const tab: Tab = { id: uid('t'), kind: 'table', title: table, connId, db, table, isView };
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

  refreshTree() {
    set((s) => ({ treeVersion: s.treeVersion + 1, schemaCache: {} }));
  },
}));
