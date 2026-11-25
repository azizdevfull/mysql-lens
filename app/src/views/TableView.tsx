import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, KeyRound, Lock, PanelRight, Play, Plus, RefreshCw, Search, Table2, Trash2, Undo2, Eye } from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp, type Tab } from '@/lib/store';
import type { Cell, Column, RowChange, SortSpec } from '@/lib/types';
import { buildTableQuery, parseTableQuery } from '@/lib/tableQuery';
import { cn, formatMs } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Kbd, Tooltip } from '@/components/ui/misc';
import { ExportMenu } from '@/components/ExportMenu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DataGrid } from '@/components/DataGrid';
import { SqlEditor } from '@/components/SqlEditor';
import { RowInspector } from '@/components/RowInspector';

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
  const [schema, setSchema] = useState<Record<string, Column[]>>();
  const [state, setState] = useState({ page: 0, pageSize: 200, sort: null as SortSpec | null, filter: '' });
  const [query, setQuery] = useState(() => buildTableQuery(table, { page: 0, pageSize: 200, sort: null, filter: '' }));
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

  const runQuery = async (sql: string) => {
    if (!guard()) return;
    const simple = parseTableQuery(sql, db, table, state.pageSize);
    if (simple) return load(simple);
    setLoading(true);
    setError('');
    try {
      const res = await backend.query(connId, db, sql);
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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && changeCount) {
        e.preventDefault();
        void openReview();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
