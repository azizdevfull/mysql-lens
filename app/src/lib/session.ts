import { backend } from './backend';
import { liveSql, useApp, type SavedTab } from './store';
import type { PageRequest } from './types';

/**
 * Session restore: open tabs, the active one, query text and table page/sort/filter
 * are saved about a second after each change and reopened on the next start.
 * Nothing connects on startup; a tab connects when it is first shown.
 */

const VERSION = 1;
const DELAY = 1000;

interface Saved {
  version: number;
  active: number;
  tabs: SavedTab[];
}

let timer: number | undefined;
let started = false;

function snapshot(): Saved {
  const { tabs, active } = useApp.getState();
  const real = tabs.filter((t) => t.kind !== 'welcome');
  return {
    version: VERSION,
    active: Math.max(0, real.findIndex((t) => t.id === active)),
    tabs: real.map((t) => ({
      kind: t.kind,
      title: t.title,
      connId: t.connId,
      db: t.db,
      table: t.table,
      isView: t.isView,
      sql: t.kind === 'query' ? (liveSql.get(t.id) ?? t.sql ?? '') : undefined,
      tableState: t.tableState,
    })),
  };
}

async function save(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  try {
    await backend.saveSession(JSON.stringify(snapshot()));
  } catch {
    // Losing the session is an inconvenience, not an error worth interrupting for.
  }
}

/** Saves the session about a second from now (calls in between are merged). */
export function scheduleSessionSave(): void {
  if (!started) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void save(), DELAY);
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function pageRequest(v: unknown): PageRequest | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const page = Number(o.page);
  const pageSize = Number(o.pageSize);
  if (!Number.isInteger(page) || page < 0 || !Number.isInteger(pageSize) || pageSize <= 0) return undefined;
  const s = o.sort as Record<string, unknown> | null;
  const sort = s && typeof s.column === 'string' && (s.dir === 'asc' || s.dir === 'desc') ? { column: s.column, dir: s.dir as 'asc' | 'desc' } : null;
  return { page, pageSize, sort, filter: str(o.filter) ?? '' };
}

/** Saved tabs that still make sense: table tabs need their connection; query tabs keep their text. */
export function parseSession(text: string, connIds: Set<string>): { tabs: SavedTab[]; active: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const o = raw as Partial<Saved> | null;
  if (!o || o.version !== VERSION || !Array.isArray(o.tabs)) return null;
  const tabs: SavedTab[] = [];
  let active = 0;
  o.tabs.forEach((t: unknown, i) => {
    if (!t || typeof t !== 'object') return;
    const x = t as Record<string, unknown>;
    const connId = str(x.connId);
    const known = !!connId && connIds.has(connId);
    if (i === o.active) active = tabs.length;
    if (x.kind === 'table') {
      const table = str(x.table);
      const db = str(x.db);
      if (!known || !table || !db) return; // deleted connection: nothing to show
      tabs.push({ kind: 'table', title: str(x.title) ?? table, connId, db, table, isView: x.isView === true, tableState: pageRequest(x.tableState) });
    } else if (x.kind === 'query') {
      // A query tab of a deleted connection keeps its text; the user picks another connection.
      tabs.push({ kind: 'query', title: str(x.title) ?? 'Query', connId: known ? connId : undefined, db: known ? str(x.db) : undefined, sql: str(x.sql) ?? '' });
    }
  });
  return { tabs, active: Math.min(active, Math.max(0, tabs.length - 1)) };
}

/** Restores the previous session (if enabled) and starts saving changes. Call once after connections load. */
export async function startSession(): Promise<void> {
  if (started) return;
  const st = useApp.getState();
  if (st.restoreSession) {
    const text = await backend.loadSession().catch(() => null);
    const parsed = text ? parseSession(text, new Set(st.connections.map((c) => c.id))) : null;
    if (parsed?.tabs.length) {
      useApp.getState().restoreTabs(parsed.tabs, parsed.active);
    }
  }
  started = true;
  useApp.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs || s.active !== prev.active) scheduleSessionSave();
  });
  // Best effort when the window goes away; the debounce already limits the loss to ~1 s.
  window.addEventListener('pagehide', () => void save());
}
