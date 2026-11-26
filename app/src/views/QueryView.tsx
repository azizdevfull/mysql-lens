import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { toast } from 'sonner';
import { AlertCircle, CheckCircle2, ChevronDown, Database, History, ListChecks, Loader2, Play, PlayCircle, Square, Table2, TerminalSquare, WandSparkles } from 'lucide-react';
import { openHistory } from '@/components/HistoryDialog';
import { backend } from '@/lib/backend';
import { liveSql, useApp, type Tab } from '@/lib/store';
import { scheduleSessionSave } from '@/lib/session';
import type { Column, ResultSet } from '@/lib/types';
import { cn, formatMs } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Kbd, Tooltip } from '@/components/ui/misc';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { DataGrid } from '@/components/DataGrid';
import { ExportMenu } from '@/components/ExportMenu';
import { SqlEditor } from '@/components/SqlEditor';
import { confirmRun } from '@/components/confirmRun';
import { openValueEditor } from '@/components/ValueEditor';


export function QueryView({ tab }: { tab: Tab }) {
  const connections = useApp((s) => s.connections);
  const connState = useApp((s) => s.connState);
  const connect = useApp((s) => s.connect);
  const updateTab = useApp((s) => s.updateTab);
  const loadSchema = useApp((s) => s.schema);
  const conn = connections.find((c) => c.id === tab.connId);
  const [dbs, setDbs] = useState<string[]>([]);
  const [schema, setSchema] = useState<Record<string, Column[]>>();
  const [sql, setSql] = useState(tab.sql ?? '');
  const [results, setResults] = useState<ResultSet[]>([]);
  const [active, setActive] = useState<number | 'messages'>('messages');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const runRef = useRef<((all: boolean) => void) | null>(null);
  const formatRef = useRef<(() => void) | null>(null);
  /** Id of the run in flight, for Cancel. */
  const runId = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!tab.connId) return;
    void (async () => {
      if (await connect(tab.connId!)) setDbs(await backend.databases(tab.connId!));
    })();
  }, [tab.connId, connect]);

  useEffect(() => {
    if (tab.connId && tab.db && connState[tab.connId] === 'on') void loadSchema(tab.connId, tab.db).then(setSchema);
  }, [tab.connId, tab.db, connState, loadSchema]);

  const run = useCallback(
    async (statements: string[]) => {
      if (!tab.connId || !statements.length || running) return;
      if (!(await confirmRun(conn, statements))) return;
      setRunning(true);
      const id = `${tab.id}-${Date.now().toString(36)}`;
      runId.current = id;
      const started = performance.now();
      const timer = setInterval(() => setElapsed(Math.round(performance.now() - started)), 100);
      try {
        // Sent already split, so a procedure body with `;` inside stays one statement.
        const res = await backend.query(tab.connId, tab.db, statements, id);
        setResults(res);
        const firstRows = res.findIndex((r) => r.kind === 'rows');
        setActive(res.some((r) => r.kind === 'error') || firstRows < 0 ? 'messages' : firstRows);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        clearInterval(timer);
        setElapsed(Math.round(performance.now() - started));
        runId.current = null;
        setCancelling(false);
        setRunning(false);
      }
    },
    [tab.connId, tab.db, tab.id, running, conn],
  );

  const cancel = async () => {
    const id = runId.current;
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await backend.cancelQuery(id);
    } catch (e) {
      setCancelling(false);
      toast.error('Could not cancel the query', { description: String(e) });
    }
  };

  const onChange = (v: string) => {
    setSql(v);
    liveSql.set(tab.id, v);
    scheduleSessionSave();
    if (!tab.dirty) updateTab(tab.id, { dirty: true });
  };

  const rowsResults = results.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'rows');
  const errors = results.filter((r) => r.kind === 'error').length;
  const current = typeof active === 'number' ? results[active] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="max-w-72">
              <span className={cn('size-2 rounded-full', conn ? `bg-${conn.color}-500` : 'bg-muted-foreground')} style={{ backgroundColor: conn ? colorOf(conn.color) : undefined }} />
              <span className="truncate">{conn ? conn.name : 'Choose connection'}</span>
              {tab.db && (
                <>
                  <span className="text-muted-foreground">/</span>
                  <Database className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{tab.db}</span>
                </>
              )}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Connection</DropdownMenuLabel>
            {connections.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => updateTab(tab.id, { connId: c.id, db: c.database })}>
                <span className="size-2 rounded-full" style={{ backgroundColor: colorOf(c.color) }} />
                {c.name}
                {c.id === tab.connId && <CheckCircle2 className="ml-auto text-primary" />}
              </DropdownMenuItem>
            ))}
            {dbs.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Database</DropdownMenuLabel>
                {dbs.map((d) => (
                  <DropdownMenuItem key={d} onSelect={() => updateTab(tab.id, { db: d })}>
                    <Database />
                    {d}
                    {d === tab.db && <CheckCircle2 className="ml-auto text-primary" />}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="mx-1 h-5 w-px bg-border" />
        <Tooltip content="Run statement at cursor or selection" shortcut="Ctrl+Enter">
          <Button size="sm" onClick={() => runRef.current?.(false)} disabled={running || !conn}>
            {running ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />} Run
          </Button>
        </Tooltip>
        <Tooltip content="Run all statements" shortcut="Ctrl+Shift+Enter">
          <Button size="sm" variant="outline" onClick={() => runRef.current?.(true)} disabled={running || !conn}>
            <PlayCircle /> Run all
          </Button>
        </Tooltip>
        {running && (
          <Button size="sm" variant="ghost" className="text-destructive" disabled={cancelling} onClick={() => void cancel()}>
            {cancelling ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />} {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
        <Tooltip content="Format SQL (selection or all)" shortcut="Shift+Alt+F">
          <Button size="icon-sm" variant="ghost" onClick={() => formatRef.current?.()}>
            <WandSparkles />
          </Button>
        </Tooltip>
        <Tooltip content="Query history" shortcut="Ctrl+H">
          <Button size="icon-sm" variant="ghost" onClick={openHistory}>
            <History />
          </Button>
        </Tooltip>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {running ? (
            <span className="flex items-center gap-1.5 text-primary tabular-nums">
              <Loader2 className="size-3.5 animate-spin" /> Running {formatMs(elapsed)}
            </span>
          ) : results.length ? (
            <span className={cn('flex items-center gap-1.5 tabular-nums', errors ? 'text-destructive' : 'text-success')}>
              {errors ? <AlertCircle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
              {errors ? 'Failed' : 'Done'} · {formatMs(elapsed)}
            </span>
          ) : null}
        </div>
      </div>

      <PanelGroup direction="vertical" className="min-h-0 flex-1">
        <Panel defaultSize={42} minSize={15}>
          <EditorPane sql={sql} onChange={onChange} schema={schema} onRun={run} runRef={runRef} formatRef={formatRef} />
        </Panel>
        <PanelResizeHandle className="group relative h-px bg-border data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=hover]:bg-primary">
          <div className="absolute inset-x-0 -top-1 -bottom-1" />
        </PanelResizeHandle>
        <Panel minSize={20}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/30 px-2">
              {rowsResults.map(({ r, i }, n) => (
                <button
                  key={i}
                  title={r.sql}
                  onClick={() => setActive(i)}
                  className={cn('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors', active === i ? 'bg-background text-foreground shadow-xs ring-1 ring-border' : 'text-muted-foreground hover:text-foreground')}
                >
                  <Table2 className="size-3.5" />
                  Result {n + 1}
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    {r.totalRows.toLocaleString()}
                  </Badge>
                </button>
              ))}
              <button
                onClick={() => setActive('messages')}
                className={cn('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors', active === 'messages' ? 'bg-background text-foreground shadow-xs ring-1 ring-border' : 'text-muted-foreground hover:text-foreground')}
              >
                <ListChecks className="size-3.5" />
                Messages
                {errors > 0 && <Badge variant="destructive" className="h-4 px-1 text-[10px]">{errors}</Badge>}
              </button>
              {current && tab.connId && (
                <ExportMenu className="ml-auto h-7" connId={tab.connId} db={tab.db ?? ''} table={current.columns[0]?.comment || 'result'} sql={current.sql} label="Export result (re-runs the query)" />
              )}
            </div>
            <div className="relative min-h-0 flex-1">
              {current?.kind === 'rows' ? (
                <DataGrid
                  columns={current.columns}
                  rowCount={current.rows.length}
                  value={(r, c) => current.rows[r][c]}
                  dataKey={`${active}-${current.ms}-${current.sql}`}
                  onOpenValue={(r, c) => openValueEditor({ column: current.columns[c], value: current.rows[r][c], context: `Result ${rowsResults.findIndex((x) => x.i === active) + 1} · row ${r + 1}`, readOnly: true })}
                />
              ) : (
                <Messages results={results} running={running} />
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function EditorPane({ sql, onChange, schema, onRun, runRef, formatRef }: { sql: string; onChange: (v: string) => void; schema?: Record<string, Column[]>; onRun: (s: string[]) => void; runRef: React.MutableRefObject<((all: boolean) => void) | null>; formatRef: React.MutableRefObject<(() => void) | null> }) {
  return (
    <div className="h-full overflow-hidden">
      <SqlEditor
        value={sql}
        onChange={onChange}
        schema={schema}
        autoFocus
        runRef={runRef}
        formatRef={formatRef}
        placeholder={"-- Write SQL here.  Ctrl+Enter runs the statement under the cursor, Ctrl+Space shows suggestions.\nSELECT * FROM customers WHERE city = 'Tashkent' LIMIT 100;"}
        onRun={onRun}
      />
    </div>
  );
}

function Messages({ results, running }: { results: ResultSet[]; running: boolean }) {
  if (!results.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        {running ? <Loader2 className="size-7 animate-spin" /> : <TerminalSquare className="size-8 opacity-50" />}
        <div className="flex items-center gap-1.5 text-[13px]">
          {running ? 'Running…' : (
            <>
              Press <Kbd>Ctrl Enter</Kbd> to run the statement under the cursor
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="h-full space-y-2 overflow-auto p-3">
      {results.map((r, i) => (
        <div key={i} className={cn('rounded-lg border p-3', r.kind === 'error' && 'border-destructive/40 bg-destructive/5')}>
          <div className="flex items-start gap-2">
            {r.kind === 'error' ? <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />}
            <pre className="min-w-0 flex-1 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{r.sql}</pre>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatMs(r.ms)}</span>
          </div>
          <div className={cn('mt-2 pl-6 text-[13px]', r.kind === 'error' && 'font-mono text-xs text-destructive')}>
            {r.kind === 'error' ? r.error : r.kind === 'rows' ? `${r.totalRows.toLocaleString()} row(s) returned` : `${r.affectedRows ?? 0} row(s) affected`}
          </div>
        </div>
      ))}
    </div>
  );
}

export function colorOf(c: string): string {
  return { red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', purple: '#a855f7' }[c] ?? '#71717a';
}
