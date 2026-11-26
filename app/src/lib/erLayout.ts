import type DagreModule from '@dagrejs/dagre';
import type { Column, ForeignKey } from './types';

export const NODE_W = 248;
export const HEADER_H = 34;
export const ROW_H = 22;
const PAD_B = 6;
/** Longer tables show their first columns and a "+N more" row. */
export const MAX_ROWS = 24;

export interface ErTable {
  name: string;
  columns: Column[];
  isView: boolean;
}

export interface ErNode {
  name: string;
  /** Columns drawn in the box (keys only, or the first MAX_ROWS). */
  shown: Column[];
  hidden: number;
  /** Columns that are part of an outgoing foreign key. */
  fkColumns: Set<string>;
  isView: boolean;
  w: number;
  h: number;
}

export interface Pos {
  x: number;
  y: number;
}

export function buildNodes(tables: ErTable[], fks: ForeignKey[], keysOnly: boolean): Map<string, ErNode> {
  const fkCols = new Map<string, Set<string>>();
  for (const fk of fks) {
    const set = fkCols.get(fk.table) ?? new Set<string>();
    fk.columns.forEach((c) => set.add(c));
    fkCols.set(fk.table, set);
  }
  // Referenced columns stay visible in "keys only" mode too, so every line has both ends.
  const refCols = new Map<string, Set<string>>();
  for (const fk of fks) {
    const set = refCols.get(fk.refTable) ?? new Set<string>();
    fk.refColumns.forEach((c) => set.add(c));
    refCols.set(fk.refTable, set);
  }
  const out = new Map<string, ErNode>();
  for (const t of tables) {
    const fkSet = fkCols.get(t.name) ?? new Set<string>();
    const refSet = refCols.get(t.name) ?? new Set<string>();
    const wanted = keysOnly ? t.columns.filter((c) => c.pk || fkSet.has(c.name) || refSet.has(c.name)) : t.columns;
    const shown = wanted.slice(0, MAX_ROWS);
    const hidden = t.columns.length - shown.length;
    const rows = shown.length + (hidden > 0 ? 1 : 0);
    out.set(t.name, { name: t.name, shown, hidden, fkColumns: fkSet, isView: t.isView, w: NODE_W, h: HEADER_H + Math.max(rows, 1) * ROW_H + PAD_B });
  }
  return out;
}

/** dagre, passed in by the caller so it can be loaded on first use. */
export type Dagre = typeof DagreModule;

/**
 * Tables linked by foreign keys are laid out left to right (referenced tables first);
 * tables without any link go in a grid underneath, so they do not stretch the graph.
 */
export function layoutNodes(dagre: Dagre, nodes: Map<string, ErNode>, fks: ForeignKey[]): Map<string, Pos> {
  const edges = fks.filter((fk) => nodes.has(fk.table) && nodes.has(fk.refTable) && fk.table !== fk.refTable);
  const linked = new Set<string>();
  edges.forEach((e) => (linked.add(e.table), linked.add(e.refTable)));
  const pos = new Map<string, Pos>();
  let bottom = 0;
  let right = 0;

  if (linked.size) {
    const g = new dagre.graphlib.Graph<object, { width: number; height: number; x?: number; y?: number }, object>({ multigraph: true });
    g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 110, marginx: 40, marginy: 40 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const name of linked) {
      const n = nodes.get(name)!;
      g.setNode(name, { width: n.w, height: n.h });
    }
    edges.forEach((e, i) => g.setEdge(e.refTable, e.table, {}, `${e.name}#${i}`));
    dagre.layout(g);
    for (const name of linked) {
      const n = g.node(name)!;
      const p = { x: Math.round((n.x ?? 0) - n.width / 2), y: Math.round((n.y ?? 0) - n.height / 2) };
      pos.set(name, p);
      bottom = Math.max(bottom, p.y + n.height);
      right = Math.max(right, p.x + n.width);
    }
  }

  const rest = [...nodes.values()].filter((n) => !linked.has(n.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (rest.length) {
    const gap = 32;
    // As wide as the graph above (at least ~4 boxes), so the whole picture stays compact.
    const perRow = Math.max(4, Math.min(rest.length, Math.floor(Math.max(right, 4 * (NODE_W + gap)) / (NODE_W + gap))));
    let y = linked.size ? bottom + 90 : 40;
    for (let i = 0; i < rest.length; i += perRow) {
      const row = rest.slice(i, i + perRow);
      row.forEach((n, j) => pos.set(n.name, { x: 40 + j * (NODE_W + gap), y }));
      y += Math.max(...row.map((n) => n.h)) + gap;
    }
  }
  return pos;
}

/** Vertical center of a column's row inside its box (the header when the column is not shown). */
export function columnY(node: ErNode, column: string): number {
  const i = node.shown.findIndex((c) => c.name === column);
  return i < 0 ? HEADER_H / 2 : HEADER_H + i * ROW_H + ROW_H / 2;
}

/**
 * SVG path from the referencing column (child) to the referenced column (parent):
 * leaves and enters the boxes on the sides facing each other. A self reference loops
 * out on the right.
 */
export function edgePath(child: Pos, childNode: ErNode, childY: number, parent: Pos, parentNode: ErNode, parentY: number, self: boolean): string {
  const y1 = child.y + childY;
  const y2 = parent.y + parentY;
  if (self) {
    const x = child.x + childNode.w;
    const out = 46;
    return `M ${x} ${y1} C ${x + out} ${y1}, ${x + out} ${y2}, ${x} ${y2}`;
  }
  const childLeft = child.x + childNode.w / 2 > parent.x + parentNode.w / 2;
  const x1 = childLeft ? child.x : child.x + childNode.w;
  const x2 = childLeft ? parent.x + parentNode.w : parent.x;
  const d = Math.max(40, Math.abs(x2 - x1) / 2);
  const c1 = childLeft ? x1 - d : x1 + d;
  const c2 = childLeft ? x2 + d : x2 - d;
  return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
}

/** Box around all nodes. */
export function bounds(nodes: Map<string, ErNode>, pos: Map<string, Pos>): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [name, n] of nodes) {
    const p = pos.get(name);
    if (!p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + n.w + 60);
    y1 = Math.max(y1, p.y + n.h);
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
