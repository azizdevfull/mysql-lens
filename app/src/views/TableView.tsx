import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowUpRight, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Filter, KeyRound, Lock, Maximize2, PanelRight, Play, Plus, RefreshCw, Search, Table2, Trash2, Undo2, Upload, Eye } from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp, type Tab } from '@/lib/store';
import type { Cell, CellRef, Column, ForeignKey, Relations, RowChange, SortSpec } from '@/lib/types';
import { buildTableQuery, parseTableQuery, sqlName } from '@/lib/tableQuery';
import { describeTarget, foreignKeyOf, incomingTarget, isBinaryColumn, isJsonColumn, outgoingTarget, sqlLiteral } from '@/lib/relations';
import { cn, formatMs } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Kbd, Tooltip } from '@/components/ui/misc';
import { ExportMenu } from '@/components/ExportMenu';
import { openImportWizard } from '@/components/ImportWizard';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DataGrid, type GridMenuItem } from '@/components/DataGrid';
import { openValueEditor } from '@/components/ValueEditor';
import { SqlEditor } from '@/components/SqlEditor';
import { RowInspector, type Reference } from '@/components/RowInspector';
import { confirmRun } from '@/components/confirmRun';
import { splitSql } from '@/lib/sqlsplit';

interface Data {
  columns: Column[];
  rows: Cell[][];
  total: number;
  keyColumns: string[];
  ms: number;
  custom: boolean;
}

export function TableView({ tab }: { tab: Tab }) {
  const { connId, db, table, isView } = tab as Required<Pick<Tab, 'connId' | 'db' | 'table'>> & Tab;
  const conn = useApp((s) => s.connections.find((c) => c.id === connId));
  const loadSchema = useApp((s) => s.schema);
  const loadRelations = useApp((s) => s.relations);
  const [schema, setSchema] = useState<Record<string, Column[]>>();
  const [relations, setRelations] = useState<Relations>({ outgoing: [], incoming: [] });
  /** Rows pointing at the active row, per incoming foreign key (null while counting or if it failed). */
  const [refCounts, setRefCounts] = useState<(number | null)[]>([]);
  // A restored tab reopens on its saved page, sort and filter.
  const [state, setState] = useState(() => tab.tableState ?? { page: 0, pageSize: 200, sort: null as SortSpec | null, filter: '' });
  const [query, setQuery] = useState(() => buildTableQuery(table, state));
  const [data, setData] = useState<Data>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dataKey, setDataKey] = useState('0');
  const [edits, setEdits] = useState<Map<number, Map<number, Cell>>>(new Map());
  const [inserted, setInserted] = useState<{ values: Cell[]; touched: Set<number> }[]>([]);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [activeRow, setActiveRow] = useState<number>();
  const [inspector, setInspector] = useState(true);
  const [review, setReview] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const readOnly = !!conn?.readOnly || !!isView || !!data?.custom || !data?.keyColumns.length;
  const changeCount = deleted.size + inserted.length + [...edits.keys()].filter((r) => !deleted.has(r)).length;

  useEffect(() => {
    void loadSchema(connId, db).then(setSchema);
  }, [connId, db, loadSchema]);

  // Foreign keys are a convenience: without them (or without the rights to read them) the table still works.
  const treeVersion = useApp((s) => s.treeVersion);
  useEffect(() => {
    if (isView) return;
    loadRelations(connId, db, table).then(setRelations, () => setRelations({ outgoing: [], incoming: [] }));
  }, [connId, db, table, isView, loadRelations, treeVersion]);

  const resetEdits = () => {
    setEdits(new Map());
    setInserted([]);
    setDeleted(new Set());
  };

  const load = useCallback(
    async (next = state) => {
      setLoading(true);
      setError('');
      try {
        const p = await backend.tablePage(connId, db, table, next);
        setData({ ...p, custom: false });
        setState(next);
        useApp.getState().updateTab(tab.id, { tableState: next });
        setQuery(buildTableQuery(table, next));
        resetEdits();
        setDataKey(`${Date.now()}`);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connId, db, table, state],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guard = () => !changeCount || window.confirm(`Discard ${changeCount} unsaved change(s)?`);

  // Sent here by a foreign key link while already open: show the rows it asked for.
  useEffect(() => {
    if (tab.nav && tab.tableState && guard()) void load(tab.tableState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.nav]);

  const runQuery = async (sql: string) => {
    if (!guard()) return;
    const simple = parseTableQuery(sql, db, table, state.pageSize);
    if (simple) return load(simple);
    const statements = splitSql(sql).map((s) => s.sql);
    if (!(await confirmRun(conn, statements))) return;
    setLoading(true);
    setError('');
    try {
      const res = await backend.query(connId, db, statements);
      const err = res.find((r) => r.kind === 'error');
      if (err) throw new Error(err.error);
      const rows = [...res].reverse().find((r) => r.kind === 'rows');
      if (rows) {
        setData({ columns: rows.columns, rows: rows.rows, total: rows.totalRows, keyColumns: [], ms: rows.ms, custom: true });
        resetEdits();
        setDataKey(`${Date.now()}`);
      } else {
        toast.success(res.map((r) => `${r.affectedRows ?? 0} row(s) affected`).join(' · '));
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const baseCount = data?.rows.length ?? 0;
  const value = useCallback(
    (r: number, c: number): Cell => {
      if (!data) return null;
      if (r >= baseCount) return inserted[r - baseCount]?.values[c] ?? null;
      const e = edits.get(r);
      return e?.has(c) ? e.get(c)! : data.rows[r][c];
    },
    [data, edits, inserted, baseCount],
  );

  const setValue = (r: number, c: number, v: Cell) => {
    if (!data || readOnly) return;
    if (r >= baseCount) {
      setInserted((ins) => ins.map((x, i) => (i === r - baseCount ? { values: x.values.map((old, j) => (j === c ? v : old)), touched: new Set(x.touched).add(c) } : x)));
      return;
    }
    setEdits((prev) => {
      const next = new Map(prev);
      const row = new Map(next.get(r) ?? []);
      const orig = data.rows[r][c];
      if (orig === v || (orig !== null && v !== null && String(orig) === String(v))) row.delete(c);
      else row.set(c, v);
      if (row.size) next.set(r, row);
      else next.delete(r);
      return next;
    });
  };

  const addRow = () => {
    if (!data || readOnly) return;
    setInserted((ins) => [...ins, { values: data.columns.map(() => null), touched: new Set() }]);
    setActiveRow(baseCount + inserted.length);
  };

  const deleteRows = (rows: number[]) => {
    const newOnes = rows.filter((r) => r >= baseCount).map((r) => r - baseCount);
    if (newOnes.length) setInserted((ins) => ins.filter((_, i) => !newOnes.includes(i)));
    setDeleted((d) => {
      const next = new Set(d);
      const existing = rows.filter((r) => r < baseCount);
      const allDeleted = existing.every((r) => next.has(r));
      existing.forEach((r) => (allDeleted ? next.delete(r) : next.add(r)));
      return next;
    });
  };

  const changes = (): RowChange[] => {
    if (!data) return [];
    const keyIdx = data.keyColumns.map((k) => data.columns.findIndex((c) => c.name === k));
    const keyOf = (r: number) => Object.fromEntries(data.keyColumns.map((k, i) => [k, data.rows[r][keyIdx[i]]]));
    const out: RowChange[] = [];
    for (const [r, e] of edits) if (!deleted.has(r)) out.push({ kind: 'update', key: keyOf(r), values: Object.fromEntries([...e].map(([c, v]) => [data.columns[c].name, v])) });
    for (const r of [...deleted].sort((a, b) => a - b)) out.push({ kind: 'delete', key: keyOf(r) });
    for (const ins of inserted) out.push({ kind: 'insert', values: Object.fromEntries([...ins.touched].map((c) => [data.columns[c].name, ins.values[c]])) });
    return out;
  };

  const openReview = async () => {
    if (!data || !changeCount) return;
    setReview(await backend.previewChanges(connId, db, table, data.columns, changes()));
  };

  const save = async () => {
    if (!data) return;
    setSaving(true);
    try {
      await backend.applyChanges(connId, db, table, data.columns, changes());
      toast.success(`${changeCount} change${changeCount === 1 ? '' : 's'} saved`);
      setReview(null);
      await load();
    } catch (e) {
      toast.error('Changes were not saved', { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the visible table tab reacts (hidden tabs stay mounted).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && changeCount && useApp.getState().active === tab.id) {
        e.preventDefault();
        void openReview();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ----------------------------- relations and values ----------------------------- */

  const rowGetter = (r: number) => (name: string) => {
    const c = data?.columns.findIndex((x) => x.name === name) ?? -1;
    return c < 0 ? undefined : value(r, c);
  };

  // Links only on the table's own rows: custom query results may have other columns.
  const fkAt = useCallback((col: number): ForeignKey | undefined => (data && !data.custom ? foreignKeyOf(relations.outgoing, data.columns[col]?.name) : undefined), [data, relations]);
  const linkOf = useCallback((col: number) => {
    const fk = fkAt(col);
    return fk ? describeTarget(fk, db) : undefined;
  }, [fkAt, db]);

  const follow = (row: number, col: number) => {
    const fk = fkAt(col);
    if (!fk || !data) return;
    const target = outgoingTarget(fk, data.columns, rowGetter(row));
    if (!target) return toast.info(`${data.columns[col].name} is NULL: it does not point at any row`);
    useApp.getState().openTable(connId, target.db, target.table, false, target.filter);
  };

  const openReferencing = (fk: ForeignKey, row: number) => {
    if (!data) return;
    const target = incomingTarget(fk, data.columns, (name) => {
      const c = data.columns.findIndex((x) => x.name === name);
      return c < 0 ? undefined : data.rows[row]?.[c];
    });
    if (target) useApp.getState().openTable(connId, target.db, target.table, false, target.filter);
  };

  /** Where a stored cell lives, so the value editor can read a large value in full. */
  const cellRef = (row: number, col: number): CellRef | undefined => {
    if (!data || data.custom || row >= baseCount || !data.keyColumns.length) return undefined;
    const key = Object.fromEntries(data.keyColumns.map((k) => [k, data.rows[row][data.columns.findIndex((c) => c.name === k)]]));
    return { connId, db, table, column: data.columns[col].name, columns: data.columns, key };
  };

  const openValue = (row: number, col: number) => {
    if (!data) return;
    const c = data.columns[col];
    openValueEditor({
      column: c,
      value: value(row, col),
      context: `${table} · ${row >= baseCount ? 'new row' : `row ${state.page * state.pageSize + row + 1}`}`,
      readOnly: readOnly || deleted.has(row) || (!!c.autoIncrement && value(row, col) === null),
      // A pending (unsaved) value is not in the table yet, so it is not read back from there.
      cell: edits.get(row)?.has(col) ? undefined : cellRef(row, col),
      onApply: (v) => setValue(row, col, v),
    });
  };

  const filterBy = (row: number, col: number) => {
    if (!data || data.custom || !guard()) return;
    const c = data.columns[col];
    const v = value(row, col);
    const cond = v === null ? `${sqlName(c.name)} IS NULL` : `${sqlName(c.name)} = ${sqlLiteral(v, c)}`;
    void load({ ...state, page: 0, filter: state.filter.trim() ? `(${state.filter.trim()}) AND ${cond}` : cond });
  };

  const menuItems = (row: number, col: number): GridMenuItem[] => {
    if (!data) return [];
    const c = data.columns[col];
    const items: GridMenuItem[] = [];
    const fk = fkAt(col);
    if (fk) items.push({ label: `Open in ${fk.refTable}`, icon: <ArrowUpRight />, shortcut: 'Ctrl Click', onSelect: () => follow(row, col) });
    if (isJsonColumn(c) || isBinaryColumn(c) || /text|char/i.test(c.type)) items.push({ label: 'Open value editor', icon: <Maximize2 />, onSelect: () => openValue(row, col) });
    if (!data.custom && row < baseCount && !isBinaryColumn(c)) items.push({ label: 'Filter by this value', icon: <Filter />, onSelect: () => filterBy(row, col) });
    return items;
  };

  // Count the rows pointing at the active row (capped), shortly after it becomes active.
  const REF_CAP = 1000;
  const refRow = activeRow !== undefined && activeRow < baseCount && data && !data.custom ? activeRow : undefined;
  useEffect(() => {
    setRefCounts([]);
    if (refRow === undefined || !data || !relations.incoming.length) return;
    const items = relations.incoming.map((fk) => incomingTarget(fk, data.columns, (name) => data.rows[refRow]?.[data.columns.findIndex((x) => x.name === name)]));
    const wanted = items.flatMap((t) => (t ? [t] : []));
    if (!wanted.length) return setRefCounts(items.map(() => 0));
    let live = true;
    const timer = window.setTimeout(() => {
      backend.countRows(connId, wanted, REF_CAP).then(
        (counts) => {
          if (!live) return;
          let i = 0;
          setRefCounts(items.map((t) => (t ? counts[i++] : 0)));
        },
        () => live && setRefCounts(items.map(() => null)),
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [refRow, data, relations, connId]);

  const references: Reference[] | undefined =
    refRow === undefined || !relations.incoming.length
      ? undefined
      : relations.incoming.map((fk, i) => ({
          label: fk.db === db ? fk.table : `${fk.db}.${fk.table}`,
          detail: fk.columns.join(', '),
          count: refCounts[i] ?? null,
          counting: refCounts.length === 0,
          capped: (refCounts[i] ?? 0) >= REF_CAP,
          onOpen: () => openReferencing(fk, refRow),
        }));

  const pages = data && !data.custom ? Math.max(1, Math.ceil(data.total / state.pageSize)) : 1;
  const go = (page: number) => guard() && void load({ ...state, page: Math.max(0, Math.min(pages - 1, page)) });
  const rowCount = baseCount + inserted.length;
  const activeValues = useMemo(() => (data && activeRow !== undefined && activeRow < rowCount ? data.columns.map((_, c) => value(activeRow, c)) : undefined), [data, activeRow, rowCount, value]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {isView ? <Eye className="size-4 text-muted-foreground" /> : <Table2 className="size-4 text-primary" />}
        <div className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground">{db}</span>
          <span className="text-muted-foreground/60">/</span>
          <span className="font-semibold">{table}</span>
        </div>
        {data && !data.custom && <Badge variant="secondary">{data.total.toLocaleString()} rows</Badge>}
        {data?.keyColumns.length ? (
          <Badge variant="outline">
            <KeyRound className="size-3 text-amber-500" />
            {data.keyColumns.join(', ')}
          </Badge>
        ) : null}
        {readOnly && data && (
          <Tooltip content={conn?.readOnly ? 'Connection is read-only' : isView ? 'Views are read-only' : data.custom ? 'Custom query results are read-only' : 'No primary key: rows cannot be identified'}>
            <span>
              <Badge variant="warning">
                <Lock className="size-3" />
                Read-only
              </Badge>
            </span>
          </Tooltip>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!readOnly && (
            <Button size="sm" variant="outline" onClick={addRow}>
              <Plus /> Add row
            </Button>
          )}
          <Tooltip content="Reload" shortcut="F5">
            <Button size="icon-sm" variant="ghost" onClick={() => guard() && void (data?.custom ? runQuery(query) : load())}>
              <RefreshCw className={cn(loading && 'animate-spin')} />
            </Button>
          </Tooltip>
          {!readOnly && (
            <Tooltip content="Import CSV, Excel or JSON into this table">
              <Button size="sm" variant="ghost" onClick={() => openImportWizard(connId, db, table)}>
                <Upload /> Import
              </Button>
            </Tooltip>
          )}
          <ExportMenu connId={connId} db={db} table={table} sql={data?.custom ? query : state.filter || state.sort ? query.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*;?\s*$/i, '') : ''} label={data?.custom ? 'Export query result' : state.filter ? 'Export filtered rows (all pages)' : 'Export whole table'} />
          <Tooltip content={inspector ? 'Hide row panel' : 'Show row panel'}>
            <Button size="icon-sm" variant={inspector ? 'secondary' : 'ghost'} onClick={() => setInspector((v) => !v)}>
              <PanelRight />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Query bar */}
      <div className="flex shrink-0 items-start gap-2 border-b bg-muted/30 px-3 py-2">
        <div className="min-h-8 flex-1 overflow-hidden rounded-md border bg-background shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25 dark:bg-input/20">
          <div className="max-h-28 overflow-auto px-1">
            <SqlEditor minimal value={query} onChange={setQuery} onRun={() => void runQuery(query)} schema={schema} defaultTable={table} placeholder={`SELECT * FROM ${table} WHERE …`} />
          </div>
        </div>
        <Tooltip content="Run query" shortcut="Ctrl+Enter">
          <Button onClick={() => void runQuery(query)} disabled={loading}>
            <Play className="fill-current" /> Run
          </Button>
        </Tooltip>
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Grid + inspector */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {loading && <div className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-primary" />}
          {data && (
            <DataGrid
              columns={data.columns}
              rowCount={rowCount}
              value={value}
              dataKey={dataKey}
              editable={!readOnly}
              rowState={(r) => (r >= baseCount ? 'new' : deleted.has(r) ? 'deleted' : undefined)}
              isModified={(r, c) => (r >= baseCount ? !!inserted[r - baseCount]?.touched.has(c) : !!edits.get(r)?.has(c))}
              onEdit={setValue}
              onAppendRow={addRow}
              onDeleteRows={deleteRows}
              onActiveRow={setActiveRow}
              linkOf={linkOf}
              onFollowLink={follow}
              onOpenValue={openValue}
              menuItems={menuItems}
              sort={state.sort}
              onSort={(col) => {
                if (data.custom || !guard()) return;
                const cur = state.sort?.column === col ? state.sort.dir : null;
                const sort: SortSpec | null = cur === null ? { column: col, dir: 'asc' } : cur === 'asc' ? { column: col, dir: 'desc' } : null;
                void load({ ...state, sort, page: 0 });
              }}
            />
          )}

          {/* Floating save bar */}
          {changeCount > 0 && (
            <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-xl border bg-popover/95 py-1.5 pr-1.5 pl-4 shadow-2xl backdrop-blur animate-in slide-in-from-bottom-4 fade-in-0">
              <span className="flex items-center gap-2 text-[13px]">
                <span className="size-2 rounded-full bg-warning" />
                <b>{changeCount}</b> unsaved change{changeCount === 1 ? '' : 's'}
                <span className="text-muted-foreground">
                  {[edits.size && `${edits.size} edited`, inserted.length && `${inserted.length} new`, deleted.size && `${deleted.size} deleted`].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={resetEdits}>
                <Undo2 /> Discard
              </Button>
              <Button size="sm" onClick={() => void openReview()}>
                Review & Save <Kbd className="ml-1 border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">Ctrl S</Kbd>
              </Button>
            </div>
          )}
        </div>

        {inspector && data && (
          <RowInspector
            columns={data.columns}
            values={activeValues}
            rowLabel={activeRow === undefined ? undefined : activeRow >= baseCount ? 'New row' : `Row ${state.page * state.pageSize + activeRow + 1}`}
            readOnly={readOnly || (activeRow !== undefined && deleted.has(activeRow))}
            deleted={activeRow !== undefined && deleted.has(activeRow)}
            isModified={(c) => (activeRow === undefined ? false : activeRow >= baseCount ? !!inserted[activeRow - baseCount]?.touched.has(c) : !!edits.get(activeRow)?.has(c))}
            onChange={(c, v) => activeRow !== undefined && setValue(activeRow, c, v)}
            linkOf={(c) => {
              const fk = fkAt(c);
              return fk && activeRow !== undefined ? { label: describeTarget(fk, db), onOpen: () => follow(activeRow, c) } : undefined;
            }}
            onOpenValue={activeRow === undefined ? undefined : (c) => openValue(activeRow, c)}
            references={references}
            onDelete={readOnly || activeRow === undefined ? undefined : () => deleteRows([activeRow])}
            onDuplicate={
              readOnly || activeValues === undefined
                ? undefined
                : () => {
                    setInserted((ins) => [...ins, { values: data.columns.map((c, i) => (c.autoIncrement ? null : activeValues[i])), touched: new Set(data.columns.map((c, i) => (c.autoIncrement ? -1 : i)).filter((i) => i >= 0)) }]);
                    setActiveRow(rowCount);
                  }
            }
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-t px-3 text-xs text-muted-foreground tabular-nums">
        {data && !data.custom ? (
          <>
            <span>
              {data.total ? (state.page * state.pageSize + 1).toLocaleString() : 0}–{Math.min(data.total, (state.page + 1) * state.pageSize).toLocaleString()} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-0.5">
              <Button size="icon-xs" variant="ghost" disabled={state.page === 0} onClick={() => go(0)}>
                <ChevronsLeft />
              </Button>
              <Button size="icon-xs" variant="ghost" disabled={state.page === 0} onClick={() => go(state.page - 1)}>
                <ChevronLeft />
              </Button>
              <span className="px-1.5 text-foreground">
                {state.page + 1} / {pages.toLocaleString()}
              </span>
              <Button size="icon-xs" variant="ghost" disabled={state.page >= pages - 1} onClick={() => go(state.page + 1)}>
                <ChevronRight />
              </Button>
              <Button size="icon-xs" variant="ghost" disabled={state.page >= pages - 1} onClick={() => go(pages - 1)}>
                <ChevronsRight />
              </Button>
            </div>
            <select
              className="h-6 rounded border bg-transparent px-1 text-xs outline-none"
              value={state.pageSize}
              onChange={(e) => guard() && void load({ ...state, page: 0, pageSize: Number(e.target.value) })}
            >
              {[50, 100, 200, 500, 1000].map((n) => (
                <option key={n} value={n} className="bg-popover">
                  {n} / page
                </option>
              ))}
            </select>
          </>
        ) : (
          data && <span>{data.total.toLocaleString()} rows · query result</span>
        )}
        {data && <span>{formatMs(data.ms)}</span>}
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Search className="size-3" /> <Kbd>Ctrl F</Kbd> search
          </span>
          {!readOnly && (
            <span className="flex items-center gap-1">
              <Trash2 className="size-3" /> <Kbd>Del</Kbd> delete rows
            </span>
          )}
        </span>
      </div>

      <Dialog open={!!review} onOpenChange={(o) => !o && setReview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Save {changeCount} change{changeCount === 1 ? '' : 's'}</DialogTitle>
            <DialogDescription>These statements run in one transaction. If one fails, nothing is saved.</DialogDescription>
          </DialogHeader>
          <pre className="mx-5 max-h-[45vh] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{review?.join('\n')}</pre>
          <DialogFooter>
            <Button variant="ghost" onClick={() => review && void navigator.clipboard.writeText(review.join('\n')).then(() => toast.success('SQL copied'))}>
              Copy SQL
            </Button>
            <Button variant="outline" onClick={() => setReview(null)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving} autoFocus>
              {saving ? 'Saving…' : 'Apply changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
