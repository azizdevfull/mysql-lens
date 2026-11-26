import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertCircle, ChevronRight, Code2, Copy, Database, Download, Eye, FilePlus2, FileSpreadsheet, FileCode2, FileDown, FileUp, FolderClosed, FunctionSquare, Loader2, Lock, MoreHorizontal, Pencil, Plug, PlugZap, Plus, RefreshCw, ScrollText, Search, Server, Table2, Trash2, Upload, Workflow, Zap,
} from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp } from '@/lib/store';
import type { Connection, DbObjects } from '@/lib/types';
import { cn, formatCount } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/misc';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/menu';
import { ddlFromResult, qid, sqlTemplate, type TemplateKind } from '@/lib/sqlgen';
import { colorOf } from '@/views/QueryView';
import { ask } from '@/components/AskDialog';
import { openDumpDialog } from '@/components/DumpDialog';
import { openImportWizard } from '@/components/ImportWizard';

/** Picks a .sql file, confirms and runs it with progress in a toast. */
async function runSqlFile(connId: string, db: string | undefined, where: string) {
  const ok = await ask({ title: `Import a SQL file into ${where}?`, description: 'The file may create, change or delete data. Statements that already ran are not rolled back if you cancel.', confirm: 'Choose file…' });
  if (ok === null) return;
  const id = toast.loading('Importing…');
  try {
    const r = await backend.importSql(connId, db, false, (m) => toast.loading('Importing…', { id, description: m }));
    if (!r) return toast.dismiss(id);
    toast.success(`Imported ${r.file}`, { id, description: `${r.statements.toLocaleString()} statements executed` });
    useApp.getState().refreshTree();
  } catch (e) {
    toast.error('Import stopped', { id, description: String(e), duration: 15000 });
    useApp.getState().refreshTree();
  }
}

type DdlKind = 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'TRIGGER';

/** Opens the CREATE statement of an object in a new query tab. */
async function showDdl(connId: string, db: string, kind: DdlKind, name: string) {
  try {
    const res = await backend.query(connId, db, `SHOW CREATE ${kind} ${qid(db)}.${qid(name)}`);
    const err = res.find((r) => r.kind === 'error');
    if (err) return void toast.error(`Could not read the DDL of ${name}`, { description: err.error });
    const ddl = ddlFromResult(res);
    // Routine bodies are hidden from users without enough privileges.
    if (!ddl) return void toast.error(`Could not read the DDL of ${name}`, { description: 'The server returned no definition. You may lack the privileges to see it.' });
    const end = kind === 'TABLE' || kind === 'VIEW' ? ';' : '';
    useApp.getState().openQuery(connId, db, `-- ${kind.toLowerCase()} ${db}.${name}\n${ddl}${end}\n`);
  } catch (e) {
    toast.error(`Could not read the DDL of ${name}`, { description: String(e) });
  }
}

/** Opens a SELECT / INSERT / UPDATE / DELETE template for a table in a new query tab. */
async function openTemplate(connId: string, db: string, table: string, kind: TemplateKind) {
  try {
    const cols = await backend.columns(connId, db, table);
    useApp.getState().openQuery(connId, db, sqlTemplate(kind, table, cols));
  } catch (e) {
    toast.error(`Could not read the columns of ${table}`, { description: String(e) });
  }
}

/** Saves the connection list (without passwords) to a JSON file. */
export async function exportConnections() {
  if (!useApp.getState().connections.length) return void toast('No connections to export');
  try {
    const r = await backend.exportConnections();
    if (r) toast.success(`Exported ${r.count} connection(s)`, { description: 'Passwords were not included.', action: backend.native ? { label: 'Show file', onClick: () => void backend.revealFile(r.path) } : undefined });
  } catch (e) {
    toast.error('Export failed', { description: String(e) });
  }
}

/** Adds connections from a file made by exportConnections (or by the VS Code extension). */
export async function importConnections() {
  try {
    const r = await backend.importConnections();
    if (!r) return;
    await useApp.getState().load();
    if (!r.added) return void toast(r.skipped ? `All ${r.skipped} connection(s) are already in the list` : 'No connections found in that file');
    toast.success(`Imported ${r.added} connection(s)`, { description: `${r.skipped ? `${r.skipped} already in the list were skipped. ` : ''}Edit each one to enter its password.` });
  } catch (e) {
    toast.error('Import failed', { description: String(e) });
  }
}

/** "Generate SQL" submenu for a table or view. */
function GenerateMenu({ connId, db, table, readOnly }: { connId: string; db: string; table: string; readOnly?: boolean }) {
  const kinds: [TemplateKind, string][] = readOnly ? [['select', 'SELECT']] : [['select', 'SELECT'], ['insert', 'INSERT'], ['update', 'UPDATE'], ['delete', 'DELETE']];
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Code2 /> Generate SQL
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-36">
        {kinds.map(([k, label]) => (
          <ContextMenuItem key={k} onSelect={() => void openTemplate(connId, db, table, k)}>
            {label}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** Runs one statement and reports errors as a toast. Returns true on success. */
async function exec(connId: string, db: string | undefined, sql: string, done: string): Promise<boolean> {
  const res = await backend.query(connId, db, sql).catch((e) => [{ kind: 'error', error: String(e) }] as { kind: string; error?: string }[]);
  const err = res.find((r) => r.kind === 'error');
  if (err) {
    toast.error('Failed', { description: err.error });
    return false;
  }
  toast.success(done);
  useApp.getState().refreshTree();
  return true;
}

function Row({
  depth, icon, label, meta, open, expandable, onClick, active, actions, children, className,
}: {
  depth: number; icon: React.ReactNode; label: React.ReactNode; meta?: React.ReactNode; open?: boolean; expandable?: boolean; onClick?: () => void; active?: boolean; actions?: React.ReactNode; children?: React.ReactNode; className?: string;
}) {
  return (
    <>
      <div
        role="treeitem"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => e.key === 'Enter' && onClick?.()}
        className={cn('group flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-[13px] outline-none select-none hover:bg-accent focus-visible:bg-accent', active && 'bg-accent', className)}
        style={{ paddingLeft: depth * 14 + 6 }}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', !expandable && 'invisible', open && 'rotate-90')} />
        <span className="flex shrink-0 items-center [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 truncate">{label}</span>
        {meta && <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums group-hover:hidden">{meta}</span>}
        {actions && <span className="ml-auto hidden shrink-0 items-center group-hover:flex">{actions}</span>}
      </div>
      {open && children}
    </>
  );
}

function ConnectionNode({ c, filter }: { c: Connection; filter: string }) {
  const state = useApp((s) => s.connState[c.id] ?? 'off');
  const error = useApp((s) => s.connError[c.id]);
  const { connect, disconnect, openQuery, openConnDialog } = useApp.getState();
  const treeVersion = useApp((s) => s.treeVersion);
  const [open, setOpen] = useState(false);
  const [dbs, setDbs] = useState<string[]>();

  useEffect(() => {
    if (open && state === 'on') void backend.databases(c.id).then(setDbs);
  }, [open, state, c.id, treeVersion]);

  const toggle = async () => {
    if (open) return setOpen(false);
    if (await connect(c.id)) setOpen(true);
  };

  const statusIcon =
    state === 'connecting' ? <Loader2 className="animate-spin text-muted-foreground" /> : state === 'error' ? <AlertCircle className="text-destructive" /> : <Server style={{ color: colorOf(c.color) }} />;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Row
            depth={0}
            open={open}
            expandable
            onClick={() => void toggle()}
            icon={statusIcon}
            label={
              <span className="flex items-center gap-1.5">
                <span className="font-semibold">{c.name}</span>
                {c.readOnly && <Lock className="size-3 text-muted-foreground" />}
                {state === 'on' && <span className="size-1.5 rounded-full bg-success" />}
              </span>
            }
            meta={<span className="font-normal">{c.ssh ? 'SSH' : c.host}</span>}
            actions={
              <>
                <Tooltip content="New query">
                  <Button size="icon-xs" variant="ghost" onClick={(e) => (e.stopPropagation(), openQuery(c.id, c.database))}>
                    <FilePlus2 />
                  </Button>
                </Tooltip>
                <Tooltip content="Edit connection">
                  <Button size="icon-xs" variant="ghost" onClick={(e) => (e.stopPropagation(), openConnDialog(c))}>
                    <Pencil />
                  </Button>
                </Tooltip>
              </>
            }
          >
            {error && state === 'error' ? (
              <div className="mx-2 my-1 ml-8 rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive">{error}</div>
            ) : !dbs ? (
              <Row depth={1} icon={<Loader2 className="animate-spin text-muted-foreground" />} label={<span className="text-muted-foreground">Loading…</span>} />
            ) : (
              dbs.map((d) => <DatabaseNode key={d} connId={c.id} db={d} filter={filter} defaultOpen={d === c.database} />)
            )}
          </Row>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {state === 'on' ? (
          <ContextMenuItem onSelect={() => void disconnect(c.id).then(() => setOpen(false))}>
            <PlugZap /> Disconnect
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => void toggle()}>
            <Plug /> Connect
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => openQuery(c.id, c.database)} shortcut="Ctrl N">
          <FilePlus2 /> New query
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={state !== 'on'} onSelect={() => void runSqlFile(c.id, undefined, c.name)}>
          <Upload /> Import SQL file…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openConnDialog(c)}>
          <Pencil /> Edit connection…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openConnDialog({ ...c, id: '', name: `${c.name} (copy)` })}>
          <Copy /> Duplicate
        </ContextMenuItem>
        <ContextMenuItem
          disabled={state !== 'on'}
          onSelect={async () => {
            const name = await ask({ title: 'Create database', confirm: 'Create', input: { placeholder: 'database_name' } });
            if (name) await exec(c.id, undefined, `CREATE DATABASE ${qid(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`, `Database ${name} created`);
          }}
        >
          <Plus /> Create database…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={async () => {
            if ((await ask({ title: `Delete connection "${c.name}"?`, description: 'Its saved password is removed too. Databases on the server are not touched.', confirm: 'Delete', danger: true })) === null) return;
            await backend.deleteConnection(c.id);
            await useApp.getState().load();
            toast.success(`Deleted "${c.name}"`);
          }}
        >
          <Trash2 /> Delete connection
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function DatabaseNode({ connId, db, filter, defaultOpen }: { connId: string; db: string; filter: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [objs, setObjs] = useState<DbObjects>();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ tables: true });
  const { openTable, openQuery } = useApp.getState();
  const treeVersion = useApp((s) => s.treeVersion);
  const activeTab = useApp((s) => s.tabs.find((t) => t.id === s.active));

  useEffect(() => {
    if (open || filter) void backend.objects(connId, db).then(setObjs);
  }, [open, filter, connId, db, treeVersion]);

  const q = filter.toLowerCase();
  const tables = useMemo(() => (objs?.tables ?? []).filter((t) => t.kind === 'table' && (!q || t.name.toLowerCase().includes(q))), [objs, q]);
  const views = useMemo(() => (objs?.tables ?? []).filter((t) => t.kind === 'view' && (!q || t.name.toLowerCase().includes(q))), [objs, q]);
  const routines = (objs?.routines ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
  if (q && objs && !tables.length && !views.length && !routines.length && !db.includes(q)) return null;
  const isOpen = open || (!!q && !!objs);

  const group = (key: string, label: string, count: number, icon: React.ReactNode, body: React.ReactNode) =>
    count > 0 && (
      <Row depth={2} open={openGroups[key] || !!q} expandable onClick={() => setOpenGroups((g) => ({ ...g, [key]: !g[key] }))} icon={icon} label={<span className="text-muted-foreground">{label}</span>} meta={count}>
        {body}
      </Row>
    );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Row
            depth={1}
            open={isOpen}
            expandable
            onClick={() => setOpen((o) => !o)}
            icon={<Database className="text-primary" />}
            label={db}
            actions={
              <Tooltip content="New query">
                <Button size="icon-xs" variant="ghost" onClick={(e) => (e.stopPropagation(), openQuery(connId, db))}>
                  <FilePlus2 />
                </Button>
              </Tooltip>
            }
          >
            {!objs ? (
              <Row depth={2} icon={<Loader2 className="animate-spin text-muted-foreground" />} label={<span className="text-muted-foreground">Loading…</span>} />
            ) : (
              <>
                {group(
                  'tables',
                  'Tables',
                  tables.length,
                  <FolderClosed className="text-muted-foreground" />,
                  tables.map((t) => (
                    <TableNode key={t.name} connId={connId} db={db} name={t.name} rows={t.rows} active={activeTab?.table === t.name && activeTab.db === db} onOpen={() => openTable(connId, db, t.name)} />
                  )),
                )}
                {group('views', 'Views', views.length, <FolderClosed className="text-muted-foreground" />, views.map((v) => (
                  <ViewNode key={v.name} connId={connId} db={db} name={v.name} active={activeTab?.table === v.name && activeTab.db === db} onOpen={() => openTable(connId, db, v.name, true)} />
                )))}
                {group('routines', 'Routines', routines.length, <Workflow className="text-muted-foreground" />, routines.map((r) => (
                  <Row key={r.name} depth={3} icon={r.kind === 'function' ? <FunctionSquare className="text-violet-500" /> : <FileCode2 className="text-violet-500" />} label={r.name} meta={r.kind} onClick={() => void showDdl(connId, db, r.kind === 'function' ? 'FUNCTION' : 'PROCEDURE', r.name)} />
                )))}
                {group('triggers', 'Triggers', objs.triggers.length, <Zap className="text-muted-foreground" />, objs.triggers.map((t) => (
                  <Row key={t} depth={3} icon={<Zap className="text-amber-500" />} label={t} onClick={() => void showDdl(connId, db, 'TRIGGER', t)} />
                )))}
              </>
            )}
          </Row>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => openQuery(connId, db)}>
          <FilePlus2 /> New query
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => useApp.getState().refreshTree()}>
          <RefreshCw /> Refresh
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => openDumpDialog(connId, db)}>
          <Download /> Export database (SQL dump)…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void runSqlFile(connId, db, db)}>
          <Upload /> Import SQL file…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openImportWizard(connId, db)}>
          <FileSpreadsheet /> Import CSV, Excel, JSON…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(db)}>
          <Copy /> Copy name
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={async () => {
            const typed = await ask({ title: `Drop database ${db}?`, description: `This permanently deletes every table in "${db}". Type the database name to confirm.`, confirm: 'Drop database', danger: true, input: { placeholder: db, mustEqual: db } });
            if (typed) await exec(connId, undefined, `DROP DATABASE ${qid(db)}`, `Database ${db} dropped`);
          }}
        >
          <Trash2 /> Drop database…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ViewNode({ connId, db, name, active, onOpen }: { connId: string; db: string; name: string; active: boolean; onOpen: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Row depth={3} icon={<Eye className="text-sky-500" />} label={name} onClick={onOpen} active={active} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <Eye /> Open data
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void showDdl(connId, db, 'VIEW', name)}>
          <ScrollText /> Show DDL
        </ContextMenuItem>
        <GenerateMenu connId={connId} db={db} table={name} readOnly />
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(name)}>
          <Copy /> Copy name
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TableNode({ connId, db, name, rows, active, onOpen }: { connId: string; db: string; name: string; rows: number; active: boolean; onOpen: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Row depth={3} icon={<Table2 className="text-primary/80" />} label={name} meta={formatCount(rows)} onClick={onOpen} active={active} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <Table2 /> Open data
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void showDdl(connId, db, 'TABLE', name)}>
          <ScrollText /> Show DDL
        </ContextMenuItem>
        <GenerateMenu connId={connId} db={db} table={name} />
        <ContextMenuItem onSelect={() => openImportWizard(connId, db, name)}>
          <FileSpreadsheet /> Import CSV, Excel, JSON…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(name)}>
          <Copy /> Copy name
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={async () => {
            if ((await ask({ title: `Empty table ${name}?`, description: 'TRUNCATE deletes every row and cannot be undone.', confirm: 'Truncate', danger: true })) !== null) await exec(connId, db, `TRUNCATE TABLE ${qid(name)}`, `${name} emptied`);
          }}
        >
          <Trash2 /> Truncate…
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={async () => {
            if ((await ask({ title: `Drop table ${name}?`, description: 'The table and all of its data are deleted permanently.', confirm: 'Drop table', danger: true })) !== null) await exec(connId, db, `DROP TABLE ${qid(name)}`, `${name} dropped`);
          }}
        >
          <Trash2 /> Drop table…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function Explorer() {
  const connections = useApp((s) => s.connections);
  const { openConnDialog, refreshTree } = useApp.getState();
  const [filter, setFilter] = useState('');

  return (
    <aside className="flex h-full flex-col bg-sidebar">
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Explorer</span>
        <div className="ml-auto flex items-center">
          <Tooltip content="New connection">
            <Button size="icon-xs" variant="ghost" onClick={() => openConnDialog()}>
              <Plus />
            </Button>
          </Tooltip>
          <Tooltip content="Refresh">
            <Button size="icon-xs" variant="ghost" onClick={refreshTree}>
              <RefreshCw />
            </Button>
          </Tooltip>
          <DropdownMenu>
            <Tooltip content="More">
              <DropdownMenuTrigger asChild>
                <Button size="icon-xs" variant="ghost">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void importConnections()}>
                <FileUp /> Import connections…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!connections.length} onSelect={() => void exportConnections()}>
                <FileDown /> Export connections…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tables…"
            className="h-8 w-full rounded-md border border-transparent bg-background/60 pr-2 pl-8 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring dark:bg-input/30"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3" role="tree">
        {connections.map((c) => (
          <ConnectionNode key={c.id} c={c} filter={filter} />
        ))}
        {!connections.length && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-muted-foreground">
            <Server className="size-8 opacity-50" />
            <p>No connections yet</p>
            <Button size="sm" onClick={() => openConnDialog()}>
              <Plus /> Add connection
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
