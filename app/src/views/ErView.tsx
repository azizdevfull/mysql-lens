import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, KeyRound, Link2, Loader2, Maximize, Minus, Network, Plus, RefreshCw, Search, SquareArrowOutUpRight, Table2 } from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp, type Tab } from '@/lib/store';
import type { ForeignKey } from '@/lib/types';
import { bounds, buildNodes, columnY, edgePath, layoutNodes, ROW_H, type ErNode, type ErTable, type Pos } from '@/lib/erLayout';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Kbd, Switch, Tooltip } from '@/components/ui/misc';

interface View {
  x: number;
  y: number;
  k: number;
}

/** The table under a point (events go to the diagram while it holds the pointer, so ask the page). */
const nodeAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-er-node]')?.dataset.erNode;

const MIN_K = 0.12;
const MAX_K = 2.5;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

/** Database diagram: tables with their columns, and a line per foreign key. */
export function ErView({ tab }: { tab: Tab }) {
  const { connId, db } = tab as Required<Pick<Tab, 'connId' | 'db'>>;
  const connect = useApp((s) => s.connect);
  const loadSchema = useApp((s) => s.schema);
  const treeVersion = useApp((s) => s.treeVersion);
  const [tables, setTables] = useState<ErTable[]>();
  const [fks, setFks] = useState<ForeignKey[]>([]);
  const [rows, setRows] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [keysOnly, setKeysOnly] = useState(false);
  const [pos, setPos] = useState<Map<string, Pos>>(new Map());
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const [layoutSeq, setLayoutSeq] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Load tables, columns and foreign keys.
  useEffect(() => {
    let live = true;
    setTables(undefined);
    setError('');
    void (async () => {
      try {
        if (!(await connect(connId))) throw new Error('Not connected.');
        const [schema, keys, objects] = await Promise.all([loadSchema(connId, db), backend.dbForeignKeys(connId, db), backend.objects(connId, db)]);
        if (!live) return;
        const kinds = new Map(objects.tables.map((t) => [t.name, t]));
        setRows(Object.fromEntries(objects.tables.map((t) => [t.name, t.rows])));
        setFks(keys);
        setTables(Object.entries(schema).map(([name, columns]) => ({ name, columns, isView: kinds.get(name)?.kind === 'view' })));
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [connId, db, connect, loadSchema, treeVersion]);

  const nodes = useMemo(() => (tables ? buildNodes(tables, fks, keysOnly) : new Map<string, ErNode>()), [tables, fks, keysOnly]);

  /** Fits the whole diagram (or `only` the given box) into the visible area. */
  const fit = useCallback(
    (p: Map<string, Pos>) => {
      const el = box.current;
      if (!el || !nodes.size) return;
      const b = bounds(nodes, p);
      // Room at the bottom for the hint bar.
      const k = clampK(Math.min(1, Math.min(el.clientWidth / (b.w + 80), (el.clientHeight - 56) / (b.h + 60))));
      setView({ k, x: (el.clientWidth - b.w * k) / 2 - b.x * k, y: (el.clientHeight - 56 - b.h * k) / 2 - b.y * k + 8 });
    },
    [nodes],
  );

  // Layout (dagre is loaded on first use) whenever the boxes change size or Relayout is pressed.
  useEffect(() => {
    if (!nodes.size) return;
    let live = true;
    void import('@dagrejs/dagre').then((m) => {
      if (!live) return;
      const p = layoutNodes(m.default, nodes, fks);
      setPos(p);
      fit(p);
    });
    return () => {
      live = false;
    };
    // `fit` follows `nodes`; listing it would only repeat the same layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, fks, layoutSeq]);

  // Wheel zooms around the pointer (non-passive, so the page does not scroll).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const k = clampK(v.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (f: number) => {
    const el = box.current;
    if (!el) return;
    const mx = el.clientWidth / 2;
    const my = el.clientHeight / 2;
    setView((v) => {
      const k = clampK(v.k * f);
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  };

  /** Brings a table to the middle and selects it. */
  const focusTable = (name: string) => {
    const el = box.current;
    const p = pos.get(name);
    const n = nodes.get(name);
    if (!el || !p || !n) return;
    setSelected(name);
    setView((v) => {
      const k = Math.max(v.k, 0.8);
      return { k, x: el.clientWidth / 2 - (p.x + n.w / 2) * k, y: el.clientHeight / 2 - (p.y + n.h / 2) * k };
    });
  };

  // Dragging: the background pans, a table header moves the table.
  const drag = useRef<{ kind: 'pan' | 'node'; name?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const header = (e.target as HTMLElement).closest<HTMLElement>('[data-er-header]');
    if ((e.target as HTMLElement).closest('button')) return;
    const name = header?.dataset.erHeader;
    const p = name ? pos.get(name) : undefined;
    drag.current = name && p ? { kind: 'node', name, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false } : { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else setPos((m) => new Map(m).set(d.name!, { x: Math.round(d.ox + dx / viewRef.current.k), y: Math.round(d.oy + dy / viewRef.current.k) }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    // A click: on a table selects it, on the background clears the selection.
    setSelected(nodeAt(e.clientX, e.clientY));
  };

  const openTable = (name: string) => useApp.getState().openTable(connId, db, name, nodes.get(name)?.isView);

  // What the selection touches: its own lines and the tables at their other ends.
  const related = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    fks.forEach((f) => (f.table === selected || f.refTable === selected) && (set.add(f.table), set.add(f.refTable)));
    return set;
  }, [selected, fks]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? [...nodes.keys()].filter((n) => n.toLowerCase().includes(q)) : []), [q, nodes]);

  const visibleFks = fks.filter((f) => nodes.has(f.table) && nodes.has(f.refTable));
  const b = bounds(nodes, pos);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Network className="size-4 text-violet-500" />
        <span className="text-muted-foreground">{db}</span>
        <span className="font-semibold">ER diagram</span>
        {tables && (
          <Badge variant="secondary" className="tabular-nums">
            {nodes.size} tables · {visibleFks.length} relations
          </Badge>
        )}
        <div className="relative ml-3 w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.length) focusTable(matches[0]);
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder="Find a table…"
            className="h-7 w-full rounded-md border bg-background pr-12 pl-7 text-[13px] outline-none focus:border-ring dark:bg-input/20"
          />
          {q && <span className="absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums">{matches.length}</span>}
        </div>
        <label className="ml-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={keysOnly} onCheckedChange={setKeysOnly} />
          Keys only
        </label>
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip content="Arrange again">
            <Button size="icon-sm" variant="ghost" onClick={() => setLayoutSeq((n) => n + 1)}>
              <RefreshCw />
            </Button>
          </Tooltip>
          <Button size="icon-sm" variant="ghost" onClick={() => zoomBy(1 / 1.2)}>
            <Minus />
          </Button>
          <span className="w-11 text-center text-xs text-muted-foreground tabular-nums">{Math.round(view.k * 100)}%</span>
          <Button size="icon-sm" variant="ghost" onClick={() => zoomBy(1.2)}>
            <Plus />
          </Button>
          <Tooltip content="Fit to screen">
            <Button size="icon-sm" variant="ghost" onClick={() => fit(pos)}>
              <Maximize />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div
        ref={box}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-[length:22px_22px] select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={(e) => {
          const name = nodeAt(e.clientX, e.clientY);
          if (name) openTable(name);
        }}
      >
        {error ? (
          <div className="flex h-full items-center justify-center px-10 text-center font-mono text-xs text-destructive">{error}</div>
        ) : !tables ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : !nodes.size ? (
          <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">This database has no tables.</div>
        ) : (
          <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: Math.max(1, b.x + b.w), height: Math.max(1, b.y + b.h) }}>
              <defs>
                {(['dim', 'on'] as const).map((m) => (
                  <g key={m}>
                    <marker id={`er-one-${m}-${tab.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={m === 'on' ? 'var(--primary)' : 'var(--muted-foreground)'} />
                    </marker>
                    <marker id={`er-many-${m}-${tab.id}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6">
                      <circle cx="5" cy="5" r="3.5" fill="var(--background)" stroke={m === 'on' ? 'var(--primary)' : 'var(--muted-foreground)'} strokeWidth="1.6" />
                    </marker>
                  </g>
                ))}
              </defs>
              {visibleFks.map((f, i) => {
                const cn_ = nodes.get(f.table)!;
                const pn = nodes.get(f.refTable)!;
                const cp = pos.get(f.table);
                const pp = pos.get(f.refTable);
                if (!cp || !pp) return null;
                const on = !!selected && (f.table === selected || f.refTable === selected);
                const dim = !!related && !on;
                const m = on ? 'on' : 'dim';
                return (
                  <path
                    key={`${f.table}.${f.name}.${i}`}
                    d={edgePath(cp, cn_, columnY(cn_, f.columns[0]), pp, pn, columnY(pn, f.refColumns[0]), f.table === f.refTable)}
                    fill="none"
                    stroke={on ? 'var(--primary)' : 'var(--muted-foreground)'}
                    strokeOpacity={dim ? 0.15 : on ? 1 : 0.55}
                    strokeWidth={on ? 2 : 1.4}
                    markerStart={`url(#er-many-${m}-${tab.id})`}
                    markerEnd={`url(#er-one-${m}-${tab.id})`}
                  >
                    <title>{`${f.table}(${f.columns.join(', ')}) → ${f.refTable}(${f.refColumns.join(', ')})`}</title>
                  </path>
                );
              })}
            </svg>
            {[...nodes.values()].map((n) => {
              const p = pos.get(n.name);
              if (!p) return null;
              return (
                <TableBox
                  key={n.name}
                  node={n}
                  x={p.x}
                  y={p.y}
                  rows={rows[n.name]}
                  selected={selected === n.name}
                  dim={!!related && !related.has(n.name)}
                  match={!!q && n.name.toLowerCase().includes(q)}
                  onOpen={openTable}
                />
              );
            })}
          </div>
        )}
        {tables && nodes.size > 0 && (
          <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-3 rounded-lg border bg-popover/90 px-3 py-1.5 text-[11.5px] text-muted-foreground shadow-sm backdrop-blur">
            {!visibleFks.length ? (
              <span>No foreign keys are declared in this database.</span>
            ) : (
              <>
                <span>Drag to move · wheel to zoom · click a table to see its links</span>
                <span className="flex items-center gap-1">
                  <Kbd>double-click</Kbd> opens it
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const TableBox = memo(function TableBox({ node, x, y, rows, selected, dim, match, onOpen }: { node: ErNode; x: number; y: number; rows?: number; selected: boolean; dim: boolean; match: boolean; onOpen: (name: string) => void }) {
  return (
    <div
      data-er-node={node.name}
      className={cn(
        'absolute overflow-hidden rounded-lg border bg-card shadow-md transition-[opacity,box-shadow] duration-150',
        node.isView && 'border-dashed',
        selected && 'border-primary shadow-lg ring-2 ring-primary/40',
        match && !selected && 'ring-2 ring-amber-400/70',
        dim && 'opacity-30',
      )}
      style={{ left: x, top: y, width: node.w, height: node.h }}
    >
      <div data-er-header={node.name} className={cn('group flex h-[34px] cursor-move items-center gap-1.5 border-b px-2.5', selected ? 'bg-primary/15' : 'bg-muted/60')}>
        {node.isView ? <Eye className="size-3.5 shrink-0 text-muted-foreground" /> : <Table2 className="size-3.5 shrink-0 text-primary" />}
        <span className="truncate text-[13px] font-semibold">{node.name}</span>
        {rows !== undefined && <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground tabular-nums">{rows.toLocaleString()}</span>}
        <button
          type="button"
          title="Open table"
          onClick={() => onOpen(node.name)}
          className={cn('shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground', rows === undefined && 'ml-auto')}
        >
          <SquareArrowOutUpRight className="size-3.5" />
        </button>
      </div>
      {node.shown.map((c) => (
        <div key={c.name} className="flex items-center gap-1.5 px-2.5 text-[12px]" style={{ height: ROW_H }}>
          <span className="flex w-3.5 shrink-0 justify-center">
            {c.pk ? <KeyRound className="size-3 text-amber-500" /> : node.fkColumns.has(c.name) ? <Link2 className="size-3 text-primary" /> : null}
          </span>
          <span className={cn('truncate', c.pk && 'font-medium', node.fkColumns.has(c.name) && 'text-primary')}>{c.name}</span>
          <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">{c.type}</span>
        </div>
      ))}
      {node.hidden > 0 && (
        <div className="px-2.5 text-[11px] text-muted-foreground italic" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>
          +{node.hidden} more column{node.hidden === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
});
