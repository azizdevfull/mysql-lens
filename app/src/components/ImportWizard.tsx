import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, FileSpreadsheet, FolderOpen, KeyRound, Loader2, Plus, ShieldCheck, Table2, XCircle } from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp } from '@/lib/store';
import type { Column, ImportPlan, ImportPreview, SourceOptions } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, Label, Switch } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const useWizard = create<{ target?: { connId: string; db: string; table?: string } }>(() => ({}));

export function openImportWizard(connId: string, db: string, table?: string) {
  useWizard.setState({ target: { connId, db, table } });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const TYPES = ['INT', 'BIGINT', 'DECIMAL(12,2)', 'DOUBLE', 'VARCHAR(100)', 'VARCHAR(255)', 'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TINYINT(1)', 'JSON'];

function Step({ n, title, children, disabled }: { n: number; title: string; children?: React.ReactNode; disabled?: boolean }) {
  return (
    <section className={cn('rounded-xl border', disabled && 'opacity-45')}>
      <div className="flex items-center gap-2.5 border-b px-4 py-2.5">
        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">{n}</span>
        <span className="text-[13px] font-semibold">{title}</span>
      </div>
      {!disabled && <div className="space-y-3 p-4">{children}</div>}
    </section>
  );
}

const selectCls = 'h-8 rounded-md border border-input bg-background px-2 text-[13px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30';

/** CSV / JSON / Excel → table, with preview, column mapping and a single transaction. */
export function ImportWizard() {
  const target = useWizard((s) => s.target);
  const [path, setPath] = useState<string>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [previewError, setPreviewError] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [createTable, setCreateTable] = useState(false);
  const [table, setTable] = useState('');
  const [newTable, setNewTable] = useState('');
  const [tableCols, setTableCols] = useState<Column[]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [newCols, setNewCols] = useState<{ include: boolean; name: string; type: string }[]>([]);
  const [mode, setMode] = useState<ImportPlan['mode']>('insert');
  const [truncateFirst, setTruncateFirst] = useState(false);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; msg: string }>();

  const close = () => !running && useWizard.setState({ target: undefined });

  useEffect(() => {
    if (!target) return;
    setPath(undefined);
    setPreview(undefined);
    setPreviewError('');
    setResult(undefined);
    setTable(target.table ?? '');
    setNewTable('');
    setTruncateFirst(false);
    void backend.objects(target.connId, target.db).then((o) => {
      const names = o.tables.filter((t) => t.kind === 'table').map((t) => t.name);
      setTables(names);
      setCreateTable(!target.table && !names.length);
    });
  }, [target]);

  useEffect(() => {
    if (!target || !table) return setTableCols([]);
    void backend.columns(target.connId, target.db, table).then(setTableCols);
  }, [target, table]);

  // Auto-map by name, else by position.
  useEffect(() => {
    if (!preview || !tableCols.length) return;
    const src = preview.sourceColumns;
    const m: Record<string, number> = {};
    tableCols.forEach((c) => (m[c.name] = src.findIndex((s) => norm(s) === norm(c.name))));
    if (Object.values(m).every((v) => v < 0)) tableCols.forEach((c, i) => (m[c.name] = !c.autoIncrement && i < src.length ? i : -1));
    setMapping(m);
  }, [preview, tableCols]);

  const loadPreview = async (p: string, opts?: SourceOptions) => {
    setPreviewError('');
    setResult(undefined);
    try {
      const pv = await backend.importPreview(p, opts);
      setPreview(pv);
      const seen = new Set<string>();
      setNewCols(
        pv.sourceColumns.map((c, i) => {
          let name = c.trim().replace(/\s+/g, '_').replace(/[^\w$]/g, '').slice(0, 64) || `column_${i + 1}`;
          while (seen.has(name.toLowerCase())) name += '_';
          seen.add(name.toLowerCase());
          return { include: true, name, type: pv.inferredTypes[i] };
        }),
      );
      setNewTable((t) => t || pv.fileName.replace(/\.[^.]+$/, '').replace(/[^\w$]/g, '_').toLowerCase().slice(0, 64));
    } catch (e) {
      setPreview(undefined);
      setPreviewError(String(e));
    }
  };

  const pick = async () => {
    const p = await backend.pickDataFile();
    if (!p) return;
    setPath(p);
    await loadPreview(p);
  };

  const setOpt = (patch: Partial<SourceOptions>) => preview && path && void loadPreview(path, { ...preview.options, ...patch });

  const plan: ImportPlan = useMemo(
    () => ({
      createTable,
      table: createTable ? newTable.trim() : table,
      newColumns: newCols.map((c, i) => ({ ...c, source: i })).filter((c) => c.include).map((c) => ({ name: c.name.trim(), type: c.type.trim(), source: c.source })),
      mapping: tableCols.map((c) => ({ column: c.name, source: mapping[c.name] ?? -1 })),
      mode,
      truncateFirst: !createTable && truncateFirst,
      emptyAsNull,
      batchSize: 500,
    }),
    [createTable, newTable, table, newCols, tableCols, mapping, mode, truncateFirst, emptyAsNull],
  );

  const ready = !!preview && !!plan.table && (createTable ? plan.newColumns.length > 0 : plan.mapping.some((m) => m.source >= 0));

  const run = async () => {
    if (!target || !preview || !path) return;
    setRunning(true);
    setProgress(0);
    setResult(undefined);
    const started = performance.now();
    try {
      const n = await backend.importData(target.connId, target.db, path, preview.options, plan, setProgress);
      setResult({ ok: true, msg: `Imported ${n.toLocaleString()} rows into ${plan.table} in ${((performance.now() - started) / 1000).toFixed(1)} s` });
      useApp.getState().refreshTree();
      toast.success(`Imported ${n.toLocaleString()} rows into ${plan.table}`);
    } catch (e) {
      setResult({ ok: false, msg: `Nothing was saved. ${String(e)}` });
    } finally {
      setRunning(false);
    }
  };

  const rows = preview?.rows.slice(0, 30) ?? [];

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[920px]">
        <DialogHeader className="flex-row items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-success/15 text-success">
            <FileSpreadsheet className="size-5" />
          </span>
          <div>
            <DialogTitle>Import data into {target?.db}</DialogTitle>
            <DialogDescription>CSV, TSV, JSON / JSON Lines or Excel · runs in one transaction</DialogDescription>
          </div>
        </DialogHeader>

        <div className="max-h-[68vh] space-y-3 overflow-y-auto px-5 pb-1">
          <Step n={1} title="Source file">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant={preview ? 'outline' : 'default'} size="sm" onClick={() => void pick()} disabled={running}>
                <FolderOpen /> {preview ? 'Choose another file…' : 'Choose file…'}
              </Button>
              {preview && (
                <span className="flex items-center gap-1.5 text-[13px]">
                  <FileSpreadsheet className="size-4 text-success" />
                  <b>{preview.fileName}</b>
                  <span className="text-muted-foreground">· {preview.rowCount != null ? `${preview.rowCount.toLocaleString()} rows` : `${preview.sourceColumns.length} columns`}</span>
                </span>
              )}
            </div>
            {previewError && <div className="rounded-md bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">{previewError}</div>}
            {preview && (
              <>
                <div className="flex flex-wrap items-end gap-4">
                  {preview.fileKind === 'csv' && (
                    <>
                      <div className="flex flex-col gap-1">
                        <Label className="text-muted-foreground">Delimiter</Label>
                        <select className={selectCls} value={preview.options.delimiter} onChange={(e) => setOpt({ delimiter: e.target.value })}>
                          <option value=",">Comma ,</option>
                          <option value=";">Semicolon ;</option>
                          <option value={'\t'}>Tab</option>
                          <option value="|">Pipe |</option>
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label className="text-muted-foreground">Encoding</Label>
                        <select className={selectCls} value={preview.options.encoding || 'utf8'} onChange={(e) => setOpt({ encoding: e.target.value })}>
                          <option value="utf8">UTF-8</option>
                          <option value="latin1">Latin-1 / Windows-1252</option>
                        </select>
                      </div>
                    </>
                  )}
                  {preview.fileKind === 'excel' && preview.sheets.length > 1 && (
                    <div className="flex flex-col gap-1">
                      <Label className="text-muted-foreground">Sheet</Label>
                      <select className={selectCls} value={preview.options.sheet ?? preview.sheets[0]} onChange={(e) => setOpt({ sheet: e.target.value })}>
                        {preview.sheets.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {preview.fileKind !== 'json' && (
                    <label className="flex h-8 items-center gap-2 text-[13px]">
                      <Switch checked={preview.options.header} onCheckedChange={(v) => setOpt({ header: v })} /> First row is a header
                    </label>
                  )}
                </div>
                <div className="max-h-56 overflow-auto rounded-lg border">
                  <table className="w-max min-w-full border-collapse text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="border-b px-2 py-1.5 text-right font-normal text-muted-foreground">#</th>
                        {preview.sourceColumns.map((c, i) => (
                          <th key={i} className="max-w-56 border-b border-l px-2.5 py-1.5 text-left font-semibold">
                            {c}
                            <span className="block font-mono text-[10px] font-normal text-muted-foreground">{preview.inferredTypes[i].toLowerCase()}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="odd:bg-muted/30">
                          <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">{i + 1}</td>
                          {preview.sourceColumns.map((_, j) => (
                            <td key={j} className={cn('max-w-56 truncate border-l px-2.5 py-1', r[j] == null && 'text-muted-foreground italic')}>
                              {r[j] == null ? 'NULL' : String(r[j])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Step>

          <Step n={2} title="Target table" disabled={!preview}>
            <div className="flex items-center gap-3">
              <div className="grid h-8 grid-cols-2 rounded-md bg-muted p-0.5 text-xs">
                <button onClick={() => setCreateTable(false)} disabled={!tables.length} className={cn('flex items-center gap-1.5 rounded-[5px] px-3 font-medium', !createTable ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
                  <Table2 className="size-3.5" /> Existing table
                </button>
                <button onClick={() => setCreateTable(true)} className={cn('flex items-center gap-1.5 rounded-[5px] px-3 font-medium', createTable ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
                  <Plus className="size-3.5" /> New table
                </button>
              </div>
              {createTable ? (
                <Input className="w-64 font-mono" value={newTable} onChange={(e) => setNewTable(e.target.value)} placeholder="new_table_name" />
              ) : (
                <select className={cn(selectCls, 'w-64')} value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="">Select a table…</option>
                  {tables.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              )}
            </div>

            {preview && !createTable && tableCols.length > 0 && (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="pb-1.5 font-medium">Table column</th>
                    <th className="pb-1.5 font-medium">Type</th>
                    <th className="pb-1.5 font-medium" />
                    <th className="pb-1.5 font-medium">From file column</th>
                    <th className="pb-1.5 font-medium">Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {tableCols.map((c) => {
                    const idx = mapping[c.name] ?? -1;
                    const sample = idx >= 0 ? preview.rows.slice(0, 3).map((r) => r[idx]).filter((v) => v != null && v !== '').join(', ') : '';
                    return (
                      <tr key={c.name} className={cn('border-t', idx < 0 && 'opacity-55')}>
                        <td className="py-1.5 pr-2">
                          <span className="flex items-center gap-1.5">
                            {c.pk && <KeyRound className="size-3 text-amber-500" />}
                            {c.name}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 font-mono text-xs text-muted-foreground">{c.type}</td>
                        <td className="py-1.5 pr-2 text-muted-foreground">←</td>
                        <td className="py-1.5 pr-2">
                          <select className={cn(selectCls, 'w-56')} value={idx} onChange={(e) => setMapping((m) => ({ ...m, [c.name]: Number(e.target.value) }))}>
                            <option value={-1}>{c.autoIncrement ? '— auto —' : c.defaultValue != null ? '— default —' : '— skip —'}</option>
                            {preview.sourceColumns.map((s, i) => (
                              <option key={i} value={i}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="max-w-56 truncate py-1.5 text-xs text-muted-foreground" title={sample}>
                          {sample}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {preview && createTable && (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="w-8 pb-1.5" />
                    <th className="pb-1.5 font-medium">File column</th>
                    <th className="pb-1.5 font-medium">Column name</th>
                    <th className="pb-1.5 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {newCols.map((c, i) => (
                    <tr key={i} className={cn('border-t', !c.include && 'opacity-50')}>
                      <td className="py-1.5">
                        <Checkbox checked={c.include} onCheckedChange={(v) => setNewCols((x) => x.map((y, j) => (j === i ? { ...y, include: !!v } : y)))} />
                      </td>
                      <td className="py-1.5 pr-2">{preview.sourceColumns[i]}</td>
                      <td className="py-1.5 pr-2">
                        <Input value={c.name} disabled={!c.include} onChange={(e) => setNewCols((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} className="h-7 font-mono text-xs" />
                      </td>
                      <td className="py-1.5">
                        <Input list="lens-sql-types" value={c.type} disabled={!c.include} onChange={(e) => setNewCols((x) => x.map((y, j) => (j === i ? { ...y, type: e.target.value } : y)))} className="h-7 font-mono text-xs" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <datalist id="lens-sql-types">
              {TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Step>

          <Step n={3} title="Options" disabled={!preview}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground">When a row already exists</Label>
                <select className={selectCls} value={mode} onChange={(e) => setMode(e.target.value as ImportPlan['mode'])}>
                  <option value="insert">Stop with an error (INSERT)</option>
                  <option value="ignore">Skip it (INSERT IGNORE)</option>
                  <option value="replace">Overwrite it (REPLACE)</option>
                </select>
              </div>
              <div className="flex flex-col justify-end gap-2">
                <label className="flex items-center gap-2 text-[13px]">
                  <Switch checked={emptyAsNull} onCheckedChange={setEmptyAsNull} /> Empty values become NULL
                </label>
                <label className={cn('flex items-center gap-2 text-[13px]', createTable && 'opacity-50')}>
                  <Switch checked={truncateFirst} onCheckedChange={setTruncateFirst} disabled={createTable} /> Delete existing rows first
                </label>
              </div>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 text-success" /> All rows are imported in one transaction: if anything fails, nothing is saved.
            </p>
            {running && (
              <div className="flex items-center gap-2 text-[13px] text-primary">
                <Loader2 className="size-4 animate-spin" /> Importing… {progress.toLocaleString()} rows
              </div>
            )}
            {result && (
              <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]', result.ok ? 'border-success/40 bg-success/10' : 'border-destructive/40 bg-destructive/10')}>
                {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                <span className={cn(!result.ok && 'font-mono text-xs')}>{result.msg}</span>
              </div>
            )}
          </Step>
        </div>

        <DialogFooter>
          {result?.ok ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setResult(undefined);
                  setPreview(undefined);
                  setPath(undefined);
                }}
              >
                <ArrowLeft /> Import another file
              </Button>
              <Button
                onClick={() => {
                  if (target) useApp.getState().openTable(target.connId, target.db, plan.table);
                  useWizard.setState({ target: undefined });
                }}
              >
                <Table2 /> Open {plan.table}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={running}>
                Cancel
              </Button>
              <Button onClick={() => void run()} disabled={!ready || running}>
                {running ? <Loader2 className="animate-spin" /> : null} Import
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
