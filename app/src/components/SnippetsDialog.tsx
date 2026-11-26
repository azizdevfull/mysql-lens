import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { Bookmark, Copy, Pencil, Search, Trash2 } from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp } from '@/lib/store';
import type { Snippet } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Kbd, Tooltip } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { ask } from '@/components/AskDialog';
import { colorOf } from '@/views/QueryView';

const useSnippets = create<{ open: boolean }>(() => ({ open: false }));

export function openSnippets() {
  useSnippets.setState({ open: true });
}

/** Saved queries: search, open in a tab, rename, delete. */
export function SnippetsDialog() {
  const open = useSnippets((s) => s.open);
  const connections = useApp((s) => s.connections);
  const [items, setItems] = useState<Snippet[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useSnippets.setState({ open: false });

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    backend
      .snippetsList()
      .then(setItems)
      .catch((e) => toast.error('Could not read saved queries', { description: String(e) }));
  }, [open]);

  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? items.filter((s) => words.every((w) => `${s.name}\n${s.sql}\n${s.db ?? ''}`.toLowerCase().includes(w))) : items;
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const openOne = (s: Snippet) => {
    close();
    useApp.getState().openSnippet(s);
  };

  const rename = async (s: Snippet) => {
    const name = await ask({ title: 'Rename saved query', confirm: 'Rename', input: { initial: s.name } });
    if (name === null || name.trim() === s.name) return;
    try {
      const saved = await backend.snippetsSave({ ...s, name });
      setItems((xs) => xs.map((x) => (x.id === s.id ? saved : x)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
      // An open tab of this query shows the new name.
      const st = useApp.getState();
      st.tabs.filter((t) => t.snippetId === s.id).forEach((t) => st.updateTab(t.id, { title: saved.name }));
    } catch (e) {
      toast.error('Could not rename', { description: (e as Error).message });
    }
  };

  const remove = async (s: Snippet) => {
    if ((await ask({ title: `Delete “${s.name}”?`, description: 'Open tabs keep their text.', confirm: 'Delete', danger: true })) === null) return;
    try {
      await backend.snippetsDelete(s.id);
      setItems((xs) => xs.filter((x) => x.id !== s.id));
      const st = useApp.getState();
      st.tabs.filter((t) => t.snippetId === s.id).forEach((t) => st.updateTab(t.id, { snippetId: undefined }));
    } catch (e) {
      toast.error('Could not delete', { description: (e as Error).message });
    }
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setSel((i) => Math.min(i + 1, filtered.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (ev.key === 'Enter' && filtered[sel]) {
      ev.preventDefault();
      openOne(filtered[sel]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[min(620px,calc(100vh-48px))] max-w-3xl flex-col gap-0" onKeyDown={onKey}>
        <DialogTitle className="sr-only">Saved queries</DialogTitle>
        <div className="flex items-center gap-2 border-b px-4 py-3 pr-12">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search saved queries…"
            className="h-7 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!filtered.length ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-10 text-center text-muted-foreground">
              <Bookmark className="size-8 opacity-50" />
              <p className="text-[13px]">
                {items.length ? (
                  'No saved queries match your search.'
                ) : (
                  <>
                    Press <Kbd>Ctrl S</Kbd> in a query tab to save its SQL under a name.
                  </>
                )}
              </p>
            </div>
          ) : (
            filtered.map((s, i) => {
              const conn = connections.find((c) => c.id === s.connId);
              return (
                <div
                  key={s.id}
                  data-index={i}
                  onMouseMove={() => sel !== i && setSel(i)}
                  onClick={() => openOne(s)}
                  className={cn('group cursor-pointer rounded-lg px-3 py-2', i === sel && 'bg-accent')}
                >
                  <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    <Bookmark className="size-3.5 shrink-0 text-primary" />
                    <span className="truncate text-[13px] font-medium text-foreground">{s.name}</span>
                    {conn && (
                      <span className="flex shrink-0 items-center gap-1">
                        <span className="size-2 rounded-full" style={{ backgroundColor: colorOf(conn.color) }} />
                        {conn.name}
                        {s.db && ` / ${s.db}`}
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                      <Tooltip content="Copy SQL">
                        <Button size="icon-xs" variant="ghost" onClick={(ev) => (ev.stopPropagation(), void navigator.clipboard.writeText(s.sql).then(() => toast.success('Copied')))}>
                          <Copy />
                        </Button>
                      </Tooltip>
                      <Tooltip content="Rename">
                        <Button size="icon-xs" variant="ghost" onClick={(ev) => (ev.stopPropagation(), void rename(s))}>
                          <Pencil />
                        </Button>
                      </Tooltip>
                      <Tooltip content="Delete">
                        <Button size="icon-xs" variant="ghost" onClick={(ev) => (ev.stopPropagation(), void remove(s))}>
                          <Trash2 />
                        </Button>
                      </Tooltip>
                    </span>
                  </div>
                  <pre className="mt-1 line-clamp-2 pl-5.5 font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground">{s.sql}</pre>
                </div>
              );
            })
          )}
        </div>
        <DialogFooter className="justify-start">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {filtered.length.toLocaleString()} saved {filtered.length === 1 ? 'query' : 'queries'}
            <span className="mx-1">·</span>
            <Kbd>↵</Kbd> open
            <span className="mx-1">·</span>
            <Kbd>Ctrl S</Kbd> in a query tab saves
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
