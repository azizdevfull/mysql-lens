import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { Archive, Eye, Table2 } from 'lucide-react';
import { backend } from '@/lib/backend';
import type { DumpOptions, TableMeta } from '@/lib/types';
import { formatCount } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox, Label, Switch } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const useDump = create<{ target?: { connId: string; db: string } }>(() => ({}));

export function openDumpDialog(connId: string, db: string) {
  useDump.setState({ target: { connId, db } });
}

/** Export a database as a SQL dump (structure, data, views, routines, triggers). */
export function DumpDialog() {
  const target = useDump((s) => s.target);
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [o, setO] = useState({ structure: true, data: true, dropObjects: true, createDatabase: false, views: true, routines: true, triggers: true, gzip: false });
  const close = () => useDump.setState({ target: undefined });

  useEffect(() => {
    if (!target) return;
    void backend.objects(target.connId, target.db).then((x) => {
      setTables(x.tables);
      setPicked(new Set(x.tables.map((t) => t.name)));
    });
  }, [target]);

  const allOn = picked.size === tables.length && tables.length > 0;
  const totalRows = useMemo(() => tables.filter((t) => picked.has(t.name)).reduce((a, t) => a + t.rows, 0), [tables, picked]);

  const run = async () => {
    if (!target) return;
    const opts: DumpOptions = { database: target.db, tables: tables.filter((t) => picked.has(t.name)).map((t) => t.name), ...o };
    close();
    const id = toast.loading(`Exporting ${target.db}…`);
    try {
      const r = await backend.dumpDatabase(target.connId, opts, (m) => toast.loading(`Exporting ${target.db}`, { id, description: m }));
      if (!r) return toast.dismiss(id);
      toast.success(`Exported ${target.db}`, {
        id,
        description: `${r.tables} tables · ${r.rows.toLocaleString()} rows → ${r.path}`,
        action: backend.native ? { label: 'Show file', onClick: () => void backend.revealFile(r.path) } : undefined,
      });
    } catch (e) {
      toast.error('Export failed', { id, description: String(e) });
    }
  };

  const opt = (key: keyof typeof o, label: string, hint?: string) => (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5">
      <span>
        <span className="block text-[13px]">{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={o[key]} onCheckedChange={(v) => setO((x) => ({ ...x, [key]: v }))} />
    </label>
  );

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader className="flex-row items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Archive className="size-5" />
          </span>
          <div>
            <DialogTitle>Export {target?.db}</DialogTitle>
            <DialogDescription>SQL dump that mysql and MySQL Lens can import</DialogDescription>
          </div>
        </DialogHeader>
        <div className="grid grid-cols-[1fr_230px] gap-4 px-5">
          <div className="flex min-h-0 flex-col rounded-lg border">
            <label className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
              <Checkbox checked={allOn} onCheckedChange={(v) => setPicked(v ? new Set(tables.map((t) => t.name)) : new Set())} />
              {picked.size} of {tables.length} objects
              <span className="ml-auto font-normal text-muted-foreground">~{formatCount(totalRows)} rows</span>
            </label>
            <div className="max-h-72 overflow-y-auto p-1">
              {tables.map((t) => (
                <label key={t.name} className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-accent">
                  <Checkbox
                    checked={picked.has(t.name)}
                    onCheckedChange={(v) =>
                      setPicked((p) => {
                        const n = new Set(p);
                        if (v) n.add(t.name);
                        else n.delete(t.name);
                        return n;
                      })
                    }
                  />
                  {t.kind === 'view' ? <Eye className="size-3.5 text-sky-500" /> : <Table2 className="size-3.5 text-primary" />}
                  <span className="truncate">{t.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{t.kind === 'view' ? 'view' : formatCount(t.rows)}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-muted-foreground">Content</Label>
            {opt('structure', 'Structure')}
            {opt('data', 'Data')}
            {opt('views', 'Views')}
            {opt('routines', 'Procedures & functions')}
            {opt('triggers', 'Triggers')}
            <Label className="mt-2 block text-muted-foreground">Options</Label>
            {opt('dropObjects', 'DROP before CREATE')}
            {opt('createDatabase', 'CREATE DATABASE', 'Restore into the same name')}
            {opt('gzip', 'Compress (.gz)')}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={!picked.size || (!o.structure && !o.data)}>
            Export…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
