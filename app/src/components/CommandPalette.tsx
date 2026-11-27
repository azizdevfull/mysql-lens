import { useEffect, useState } from 'react';
import { Bookmark, Bot, Database, Download, Eye, FileDown, FilePlus2, FileUp, History, Moon, Network, Plus, RefreshCw, RotateCcw, Server, Sun, Table2 } from 'lucide-react';
import { openHistory } from '@/components/HistoryDialog';
import { openSnippets } from '@/components/SnippetsDialog';
import { openMcp } from '@/components/McpPanel';
import { exportConnections, importConnections } from '@/components/Explorer';
import { checkForUpdates } from '@/lib/updater';
import { backend } from '@/lib/backend';
import { useApp } from '@/lib/store';
import type { Snippet, TableMeta } from '@/lib/types';
import { formatCount } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';

interface Hit {
  connId: string;
  connName: string;
  db: string;
  t: TableMeta;
}

/** Ctrl+K: jump to any table of connected servers, or run an action. */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPalette);
  const connections = useApp((s) => s.connections);
  const connState = useApp((s) => s.connState);
  const theme = useApp((s) => s.theme);
  const { openTable, openQuery, openConnDialog, toggleTheme, refreshTree, setRestoreSession, openSnippet, openEr } = useApp.getState();
  const restoreSession = useApp((s) => s.restoreSession);
  const [hits, setHits] = useState<Hit[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);

  useEffect(() => {
    if (open) backend.snippetsList().then(setSnippets, () => setSnippets([]));
  }, [open]);

  // One entry per database of the connected servers, for "ER diagram".
  const dbs = [...new Map(hits.map((h) => [`${h.connId}|${h.db}`, h])).values()];

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const out: Hit[] = [];
      for (const c of connections.filter((x) => connState[x.id] === 'on')) {
        for (const db of await backend.databases(c.id)) {
          for (const t of (await backend.objects(c.id, db)).tables) out.push({ connId: c.id, connName: c.name, db, t });
        }
      }
      setHits(out);
    })();
  }, [open, connections, connState]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent hideClose className="top-[18%] max-w-[600px] translate-y-0 gap-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command loop>
          <CommandInput placeholder="Search tables, connections and actions…" />
          <CommandList>
            <CommandEmpty>Nothing found.</CommandEmpty>
            {snippets.length > 0 && (
              <CommandGroup heading="Saved queries">
                {snippets.map((sn) => (
                  <CommandItem key={sn.id} value={`saved ${sn.name} ${sn.db ?? ''}`} onSelect={() => run(() => openSnippet(sn))}>
                    <Bookmark className="text-primary" />
                    <span>{sn.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{sn.sql.replace(/\s+/g, ' ').slice(0, 60)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {hits.length > 0 && (
              <CommandGroup heading="Tables">
                {hits.map((h) => (
                  <CommandItem key={`${h.connId}.${h.db}.${h.t.name}`} value={`${h.t.name} ${h.db} ${h.connName}`} onSelect={() => run(() => openTable(h.connId, h.db, h.t.name, h.t.kind === 'view'))}>
                    {h.t.kind === 'view' ? <Eye /> : <Table2 />}
                    <span>{h.t.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {h.connName} / {h.db}
                    </span>
                    <CommandShortcut>{formatCount(h.t.rows)} rows</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Actions">
              <CommandItem onSelect={() => run(() => openQuery())}>
                <FilePlus2 /> New query <CommandShortcut>Ctrl N</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => run(openHistory)}>
                <History /> Query history <CommandShortcut>Ctrl H</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => run(openSnippets)}>
                <Bookmark /> Saved queries…
              </CommandItem>
              <CommandItem value="ai access mcp claude cursor" onSelect={() => run(openMcp)}>
                <Bot /> AI access (MCP)…
              </CommandItem>
              {dbs.map((h) => (
                <CommandItem key={`er.${h.connId}.${h.db}`} value={`er diagram ${h.db} ${h.connName}`} onSelect={() => run(() => openEr(h.connId, h.db))}>
                  <Network /> ER diagram: {h.db}
                  <span className="text-xs text-muted-foreground">{h.connName}</span>
                </CommandItem>
              ))}
              <CommandItem onSelect={() => run(() => openConnDialog())}>
                <Plus /> New connection
              </CommandItem>
              <CommandItem onSelect={() => run(() => void importConnections())}>
                <FileUp /> Import connections…
              </CommandItem>
              <CommandItem onSelect={() => run(() => void exportConnections())}>
                <FileDown /> Export connections…
              </CommandItem>
              <CommandItem onSelect={() => run(toggleTheme)}>
                {theme === 'dark' ? <Sun /> : <Moon />} Switch to {theme === 'dark' ? 'light' : 'dark'} theme
              </CommandItem>
              <CommandItem onSelect={() => run(() => setRestoreSession(!restoreSession))}>
                <RotateCcw /> {restoreSession ? 'Stop reopening tabs on startup' : 'Reopen tabs on startup'}
              </CommandItem>
              <CommandItem onSelect={() => run(refreshTree)}>
                <RefreshCw /> Refresh explorer
              </CommandItem>
              <CommandItem onSelect={() => run(() => void checkForUpdates(true))}>
                <Download /> Check for updates
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Connections">
              {connections.map((c) => (
                <CommandItem key={c.id} value={`connect ${c.name}`} onSelect={() => run(() => openQuery(c.id, c.database))}>
                  <Server /> {c.name}
                  <span className="text-xs text-muted-foreground">{c.host}</span>
                  {connState[c.id] === 'on' && <Database className="ml-auto text-success" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
