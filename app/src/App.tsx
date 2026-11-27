import { useEffect, useState } from 'react';
import { checkForUpdates } from '@/lib/updater';
import { backend } from '@/lib/backend';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Toaster, toast } from 'sonner';
import { Command, Database, FileCode2, Home, Moon, Network, Plus, Settings, Sun, Table2, X, Eye } from 'lucide-react';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Kbd, Tooltip, TooltipProvider } from '@/components/ui/misc';
import { Explorer } from '@/components/Explorer';
import { ConnectionDialog } from '@/components/ConnectionDialog';
import { CommandPalette } from '@/components/CommandPalette';
import { AskDialog } from '@/components/AskDialog';
import { DumpDialog } from '@/components/DumpDialog';
import { ImportWizard } from '@/components/ImportWizard';
import { HistoryDialog, openHistory } from '@/components/HistoryDialog';
import { ValueEditor } from '@/components/ValueEditor';
import { SnippetsDialog } from '@/components/SnippetsDialog';
import { McpApprovalDialog, McpDialog, McpIndicator, useMcpEvents } from '@/components/McpPanel';
import { openSettings, SettingsDialog, useWebStatus, WebIndicator } from '@/components/SettingsDialog';
import { ErView } from '@/views/ErView';
import { TableView } from '@/views/TableView';
import { QueryView, colorOf } from '@/views/QueryView';
import { liveSql } from '@/lib/store';
import { startSession } from '@/lib/session';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/menu';
import releaseNotes from '../release-notes.md?raw';
import { Welcome } from '@/views/Welcome';
import { isProduction } from '@/lib/sqlSafety';

function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const connections = useApp((s) => s.connections);
  const { setActive, closeTab, openQuery, closeOthers, closeRight, closeAll } = useApp.getState();
  return (
    <div className="flex h-10 shrink-0 items-end gap-0.5 border-b bg-sidebar px-1.5">
      <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => {
          const conn = connections.find((c) => c.id === t.connId);
          const Icon = t.kind === 'welcome' ? Home : t.kind === 'query' ? FileCode2 : t.kind === 'er' ? Network : t.isView ? Eye : Table2;
          return (
            <ContextMenu key={t.id}>
            <ContextMenuTrigger asChild>
            <div
              onMouseDown={(e) => (e.button === 1 ? (e.preventDefault(), closeTab(t.id)) : setActive(t.id))}
              className={cn(
                'group relative flex h-8 max-w-56 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 border-transparent pr-1.5 pl-3 text-[13px] select-none',
                t.id === active ? 'border-border bg-background text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {t.id === active && conn && <span className="absolute inset-x-3 top-0 h-0.5 rounded-b" style={{ backgroundColor: colorOf(conn.color) }} />}
              <Icon className={cn('size-3.5 shrink-0', t.kind === 'table' && 'text-primary', t.kind === 'query' && 'text-amber-500', t.kind === 'er' && 'text-violet-500')} />
              <span className="truncate">{t.title}</span>
              {t.dirty && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60 group-hover:hidden" />}
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTab(t.id)}
                className={cn('flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground', t.id === active ? 'visible' : 'invisible group-hover:visible')}
              >
                <X className="size-3.5" />
              </button>
            </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => closeTab(t.id)} shortcut="Ctrl W">
                Close
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => closeOthers(t.id)}>Close others</ContextMenuItem>
              <ContextMenuItem onSelect={() => closeRight(t.id)}>Close to the right</ContextMenuItem>
              <ContextMenuItem onSelect={closeAll}>Close all</ContextMenuItem>
              {t.kind === 'query' && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => openQuery(t.connId, t.db, liveSql.get(t.id) ?? t.sql ?? '')}>Duplicate</ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <Tooltip content="New query" shortcut="Ctrl N">
        <Button size="icon-sm" variant="ghost" className="mb-1" onClick={() => openQuery()}>
          <Plus />
        </Button>
      </Tooltip>
    </div>
  );
}

function TitleBar() {
  const theme = useApp((s) => s.theme);
  const { setPalette, toggleTheme } = useApp.getState();
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-rail px-3" data-tauri-drag-region>
      <div className="flex items-center gap-2" data-tauri-drag-region>
        <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-blue-600 to-sky-400 text-white">
          <Database className="size-3.5" />
        </span>
        <span className="text-[13px] font-semibold">MySQL Lens</span>
      </div>
      <button
        onClick={() => setPalette(true)}
        className="mx-auto flex h-7 w-full max-w-md items-center gap-2 rounded-lg border bg-background/70 px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground dark:bg-input/20"
      >
        <Command className="size-3.5" />
        Search tables, run commands…
        <Kbd className="ml-auto">Ctrl K</Kbd>
      </button>
      <div className="flex items-center">
        <Tooltip content={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          <Button size="icon-sm" variant="ghost" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>
        <Tooltip content="Settings">
          <Button size="icon-sm" variant="ghost" onClick={openSettings}>
            <Settings />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

function StatusBar() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    if (!backend.native) return;
    void import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then((v) => {
        setVersion(v);
        // First start after an update: say so, with what changed.
        try {
          const last = localStorage.getItem('lastVersion');
          if (last && last !== v) {
            toast.success(`MySQL Lens updated to ${v}`, { description: releaseNotes.replace(/^- /gm, '• ').trim(), duration: 12000 });
          }
          localStorage.setItem('lastVersion', v);
        } catch {
          // ignore
        }
      });
  }, []);
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.active));
  const conn = useApp((s) => s.connections.find((c) => c.id === tab?.connId));
  const state = useApp((s) => (tab?.connId ? s.connState[tab.connId] : undefined));
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-rail px-3 text-[11.5px] text-muted-foreground">
      {conn ? (
        <span className="flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', state === 'on' ? 'bg-success' : 'bg-muted-foreground/50')} />
          {conn.name}
          {tab?.db && <span className="opacity-70">/ {tab.db}</span>}
          {conn.readOnly && <span className="rounded bg-warning/15 px-1 text-warning">read-only</span>}
          {isProduction(conn) && <span className="rounded bg-destructive/15 px-1 font-medium text-destructive">production</span>}
        </span>
      ) : (
        <span>No connection</span>
      )}
      <span className="ml-auto">UTF-8 · MySQL</span>
      <WebIndicator />
      <McpIndicator />
      {version && (
        <button onClick={() => void checkForUpdates(true)} className="rounded px-1 hover:bg-accent hover:text-foreground" title="Check for updates">
          v{version}
        </button>
      )}
    </div>
  );
}

export default function App() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const theme = useApp((s) => s.theme);
  const { load, setPalette, openQuery, closeTab } = useApp.getState();
  // A red frame around the work area while a production (red-tagged) connection is in use.
  // Views mount the first time their tab is shown, so restored tabs do not all connect at startup.
  const [shown, setShown] = useState<Set<string>>(() => new Set([active]));
  useEffect(() => setShown((s) => (s.has(active) ? s : new Set(s).add(active))), [active]);
  const prod = useApp((s) => isProduction(s.connections.find((c) => c.id === s.tabs.find((t) => t.id === s.active)?.connId)));
  useMcpEvents();
  useWebStatus();

  useEffect(() => {
    void load().then(startSession);
    const t = window.setTimeout(() => void checkForUpdates(false), 4000);
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        const t = useApp.getState().tabs.find((x) => x.id === useApp.getState().active);
        openQuery(t?.connId, t?.db);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        openHistory();
      } else if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        closeTab(useApp.getState().active);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [load, setPalette, openQuery, closeTab]);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <PanelGroup direction="horizontal" autoSaveId="lens-layout" className="min-h-0 flex-1">
          <Panel defaultSize={20} minSize={13} maxSize={40}>
            <Explorer />
          </Panel>
          <PanelResizeHandle className="w-px bg-border transition-colors data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=hover]:bg-primary" />
          <Panel minSize={40}>
            <div className="flex h-full min-w-0 flex-col">
              <TabBar />
              <div className={cn('relative min-h-0 flex-1', prod && 'after:pointer-events-none after:absolute after:inset-0 after:z-10 after:ring-2 after:ring-destructive/70 after:ring-inset')}>
                {tabs.map((t) => (
                  <div key={t.id} className={cn('absolute inset-0', t.id !== active && 'invisible')}>
                    {!shown.has(t.id) && t.id !== active ? null : t.kind === 'welcome' ? <Welcome /> : t.kind === 'table' ? <TableView tab={t} /> : t.kind === 'er' ? <ErView tab={t} /> : <QueryView tab={t} />}
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </PanelGroup>
        <StatusBar />
      </div>
      <ConnectionDialog />
      <CommandPalette />
      <AskDialog />
      <DumpDialog />
      <ImportWizard />
      <HistoryDialog />
      <ValueEditor />
      <SnippetsDialog />
      <McpDialog />
      <McpApprovalDialog />
      <SettingsDialog />
      <Toaster theme={theme} position="bottom-right" richColors closeButton toastOptions={{ className: 'font-sans' }} />
    </TooltipProvider>
  );
}
