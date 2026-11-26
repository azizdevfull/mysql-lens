import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { AlertCircle, Copy, History, Search, Trash2 } from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp } from '@/lib/store';
import type { HistoryEntry } from '@/lib/types';
import { cn, formatMs } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Kbd, Tooltip } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { ask } from '@/components/AskDialog';
import { colorOf } from '@/views/QueryView';

const useHistory = create<{ open: boolean }>(() => ({ open: false }));

export function openHistory() {
  useHistory.setState({ open: true });
}

/** Rendering every entry of a long history makes typing in the search box lag. */
const SHOWN = 300;

function when(ts: number): string {
  const d = new Date(ts);
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

function outcome(e: HistoryEntry): string {
  if (e.error) return 'Failed';
  if (e.rows) return `${e.rows.toLocaleString()} row(s)`;
  if (e.affected) return `${e.affected.toLocaleString()} affected`;
  return 'OK';
}

/** Ctrl+H: every executed query, searchable; Enter opens it in a new query tab. */
export function HistoryDialog() {
  const open = useHistory((s) => s.open);
  const connections = useApp((s) => s.connections);
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useHistory.setState({ open: false });

  const reload = () =>
    backend
      .historyList()
      .then(setItems)
      .catch((e) => toast.error('Could not read the history', { description: String(e) }));

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    void reload();
  }, [open]);

  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items;
    return items.filter((e) => {
      const hay = `${e.sql}\n${e.connName}\n${e.db ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, q]);
  const shown = filtered.slice(0, SHOWN);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const openEntry = (e: HistoryEntry) => {
    close();
    // The connection may have been deleted since; the tab then asks for one.
    const connId = connections.some((c) => c.id === e.connId) ? e.connId : undefined;
    useApp.getState().openQuery(connId, connId ? e.db : undefined, e.sql);
  };

  const remove = async (e: HistoryEntry) => {
    await backend.historyDelete(e.id).catch((err) => toast.error('Could not delete', { description: String(err) }));
    setItems((xs) => xs.filter((x) => x.id !== e.id));
  };

  const clearAll = async () => {
    if ((await ask({ title: 'Clear query history?', description: `All ${items.length.toLocaleString()} saved queries are deleted. This cannot be undone.`, confirm: 'Clear history', danger: true })) === null) return;
    try {
      await backend.historyClear();
      setItems([]);
    } catch (e) {
      toast.error('Could not clear the history', { description: String(e) });
    }
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setSel((i) => Math.min(i + 1, shown.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (ev.key === 'Enter' && shown[sel]) {
      ev.preventDefault();
      openEntry(shown[sel]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[min(680px,calc(100vh-48px))] max-w-3xl flex-col gap-0" onKeyDown={onKey}>
        <DialogTitle className="sr-only">Query history</DialogTitle>
        <div className="flex items-center gap-2 border-b px-4 py-3 pr-12">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search query history…"
            className="h-7 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!shown.length ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <History className="size-8 opacity-50" />
              <p className="text-[13px]">{items.length ? 'No queries match your search.' : 'Queries you run appear here.'}</p>
            </div>
          ) : (
            shown.map((e, i) => {
              const conn = connections.find((c) => c.id === e.connId);
              return (
                <div
                  key={e.id}
                  data-index={i}
                  onMouseMove={() => sel !== i && setSel(i)}
                  onClick={() => openEntry(e)}
                  className={cn('group cursor-pointer rounded-lg px-3 py-2', i === sel && 'bg-accent')}
                >
                  <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: conn ? colorOf(conn.color) : undefined }} />
                    <span className="truncate font-medium text-foreground/80">{conn?.name || e.connName || 'Deleted connection'}</span>
                    {e.db && <span className="truncate">/ {e.db}</span>}
                    <span>·</span>
                    <span className="shrink-0">{when(e.ts)}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
                      {e.error ? (
                        <Badge variant="destructive" className="h-4 gap-1 px-1 text-[10px]">
                          <AlertCircle className="size-3" /> Failed
                        </Badge>
                      ) : (
                        <span>{outcome(e)}</span>
                      )}
                      <span>{formatMs(e.ms)}</span>
                      <span className="flex items-center opacity-0 group-hover:opacity-100">
                        <Tooltip content="Copy SQL">
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              void navigator.clipboard.writeText(e.sql).then(() => toast.success('Copied'));
                            }}
                          >
                            <Copy />
                          </Button>
                        </Tooltip>
                        <Tooltip content="Remove from history">
                          <Button size="icon-xs" variant="ghost" onClick={(ev) => (ev.stopPropagation(), void remove(e))}>
                            <Trash2 />
                          </Button>
                        </Tooltip>
                      </span>
                    </span>
                  </div>
                  <pre className="mt-1 line-clamp-3 font-mono text-xs whitespace-pre-wrap break-all text-foreground">{e.sql}</pre>
                  {e.error && <div className="mt-1 truncate font-mono text-[11px] text-destructive">{e.error}</div>}
                </div>
              );
            })
          )}
        </div>
        <DialogFooter className="justify-between">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {filtered.length > SHOWN ? `${SHOWN} of ${filtered.length.toLocaleString()} shown · refine the search` : `${filtered.length.toLocaleString()} ${filtered.length === 1 ? 'query' : 'queries'}`}
            <span className="mx-1">·</span>
            <Kbd>↵</Kbd> open in a new tab
          </span>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={!items.length} onClick={() => void clearAll()}>
            <Trash2 /> Clear history
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
