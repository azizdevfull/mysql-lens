import type { Cell, ColumnInfo, RowChange } from '../../src/shared/protocol';
import { contextMenu, h, icon, MenuItem, modal } from '../common/dom';

const ROW_H = 24;
const HEADER_H = 40;
const ROWNUM_W = 52;
const OVERSCAN = 8;

export interface GridOptions {
  /** Sorting is done by the caller (server side) instead of in the grid. */
  serverSort?: boolean;
  onSort?: (column: number, dir: 'asc' | 'desc' | null) => void;
  onChange?: () => void;
  onSelection?: () => void;
  onFilterByValue?: (column: ColumnInfo, value: Cell, op: '=' | '<>') => void;
  onCopy: (text: string) => void;
  onOpenText: (text: string, language: string) => void;
}

interface Sel {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

type CopyFormat = 'tsv' | 'csv' | 'json' | 'sql' | 'markdown' | 'in';

export class DataGrid {
  readonly el: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private editor: HTMLElement | null = null;

  private columns: ColumnInfo[] = [];
  private base: Cell[][] = [];
  private edits = new Map<number, Map<number, Cell>>();
  private inserted: Cell[][] = [];
  private insertedTouched: Set<number>[] = [];
  private deleted = new Set<number>();
  private view: number[] = [];
  private widths: number[] = [];
  private offsets: number[] = [];
  private totalWidth = 0;

  private editable = false;
  private keyColumns: string[] = [];
  private sort: { col: number; dir: 'asc' | 'desc' } | null = null;
  private quickFilter = '';
  private tableName = 'table';

  private sel: Sel | null = null;
  private rowMode = false;
  private dragging = false;
  private raf = 0;
  private measureCtx: CanvasRenderingContext2D | null = null;
  private readonly serverSort: boolean;
  private lastDown: { r: number; c: number; t: number } | null = null;

  constructor(private readonly opts: GridOptions) {
    this.serverSort = !!opts.serverSort;
    this.header = h('div.grid-header');
    this.body = h('div.grid-body');
    this.scroller = h('div.grid-scroll', { tabIndex: 0 }, this.header, this.body);
    this.el = h('div.grid', null, this.scroller);

    this.scroller.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.scroller.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.scroller.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.scroller.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mouseup', () => (this.dragging = false));
  }

  /* ------------------------------ data ------------------------------ */

  setData(columns: ColumnInfo[], rows: Cell[][], o: { editable?: boolean; keyColumns?: string[]; sort?: { col: number; dir: 'asc' | 'desc' } | null; keepScroll?: boolean; tableName?: string } = {}): void {
    const sameShape = columns.length === this.columns.length && columns.every((c, i) => c.name === this.columns[i]?.name);
    this.columns = columns;
    this.base = rows;
    this.edits.clear();
    this.inserted = [];
    this.insertedTouched = [];
    this.deleted.clear();
    this.editable = !!o.editable;
    this.keyColumns = o.keyColumns ?? [];
    this.sort = o.sort ?? null;
    this.tableName = o.tableName ?? columns[0]?.table ?? 'table';
    this.closeEditor(false);
    if (!sameShape || !this.widths.length) {
      this.measure();
    }
    if (!o.keepScroll) {
      this.scroller.scrollTop = 0;
      this.scroller.scrollLeft = 0;
      this.sel = rows.length && columns.length ? { r0: 0, c0: 0, r1: 0, c1: 0 } : null;
    } else if (this.sel) {
      this.clampSel();
    }
    this.rebuildView();
  }

  get columnCount(): number {
    return this.columns.length;
  }

  get visibleRowCount(): number {
    return this.view.length;
  }

  setQuickFilter(text: string): void {
    this.quickFilter = text.trim().toLowerCase();
    this.rebuildView();
  }

  focus(): void {
    this.scroller.focus({ preventScroll: true });
  }

  private rowValues(id: number): Cell[] {
    if (id >= this.base.length) {
      return this.inserted[id - this.base.length];
    }
    const e = this.edits.get(id);
    if (!e) {
      return this.base[id];
    }
    const r = this.base[id].slice();
    for (const [c, v] of e) {
      r[c] = v;
    }
    return r;
  }

  private value(id: number, c: number): Cell {
    if (id >= this.base.length) {
      return this.inserted[id - this.base.length][c];
    }
    const e = this.edits.get(id);
    return e && e.has(c) ? e.get(c)! : this.base[id][c];
  }

  private rebuildView(): void {
    let ids = this.base.map((_, i) => i);
    if (this.quickFilter) {
      const q = this.quickFilter;
      ids = ids.filter((id) => this.rowValues(id).some((v) => v !== null && String(v).toLowerCase().includes(q)));
    }
    if (this.sort && !this.serverSort) {
      const { col, dir } = this.sort;
      const numeric = this.columns[col]?.numeric;
      const cmp = (a: number, b: number) => {
        const x = this.value(a, col);
        const y = this.value(b, col);
        if (x === y) return 0;
        if (x === null) return -1;
        if (y === null) return 1;
        if (numeric) return Number(x) - Number(y);
        return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
      };
      ids.sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a)));
    }
    this.view = [...ids, ...this.inserted.map((_, i) => this.base.length + i)];
    this.clampSel();
    this.renderHeader();
    this.body.style.height = `${this.view.length * ROW_H}px`;
    this.body.style.width = `${this.totalWidth}px`;
    this.render();
    this.opts.onSelection?.();
  }

  /* ------------------------------ layout ------------------------------ */

  private textWidth(s: string, bold = false): number {
    if (!this.measureCtx) {
      this.measureCtx = document.createElement('canvas').getContext('2d');
    }
    const ctx = this.measureCtx!;
    const cs = getComputedStyle(document.body);
    ctx.font = `${bold ? '600 ' : ''}${cs.fontSize} ${cs.fontFamily}`;
    return ctx.measureText(s).width;
  }

  private measure(): void {
    const sample = this.base.slice(0, 200);
    this.widths = this.columns.map((c, i) => {
      let w = Math.max(this.textWidth(c.name, true) + 44, this.textWidth(c.type) * 0.85 + 24);
      for (const r of sample) {
        const v = r[i];
        const s = v === null ? 'NULL' : String(v).slice(0, 80);
        w = Math.max(w, this.textWidth(s) + 20);
      }
      return Math.round(Math.min(360, Math.max(64, w)));
    });
    this.layoutColumns();
  }

  private layoutColumns(): void {
    this.offsets = [];
    let x = 0;
    for (const w of this.widths) {
      this.offsets.push(x);
      x += w;
    }
    this.totalWidth = ROWNUM_W + x;
  }

  private visibleCols(): [number, number] {
    const left = Math.max(0, this.scroller.scrollLeft - ROWNUM_W);
    const right = left + this.scroller.clientWidth;
    let first = 0;
    while (first < this.columns.length - 1 && this.offsets[first] + this.widths[first] < left) first++;
    let last = first;
    while (last < this.columns.length - 1 && this.offsets[last + 1] < right) last++;
    return [Math.max(0, first - 1), Math.min(this.columns.length - 1, last + 1)];
  }

  private schedule(): void {
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.renderHeader();
        this.render();
      });
    }
  }

  /* ------------------------------ render ------------------------------ */

  private renderHeader(): void {
    const [c0, c1] = this.visibleCols();
    const cells: HTMLElement[] = [
      h('div.hcell.rownum', { title: 'Select all', onclick: () => this.selectAll() }, h('span.muted', null, '#')),
      h('div', { style: { width: `${this.offsets[c0] ?? 0}px`, flex: 'none' } }),
    ];
    for (let c = c0; c <= c1 && c < this.columns.length; c++) {
      const col = this.columns[c];
      const sorted = this.sort?.col === c ? this.sort.dir : null;
      const selected = this.sel && !this.rowMode && c >= Math.min(this.sel.c0, this.sel.c1) && c <= Math.max(this.sel.c0, this.sel.c1);
      const tip = [
        `${col.name}  ${col.type}`,
        col.pk ? 'PRIMARY KEY' : '',
        col.nullable === false ? 'NOT NULL' : '',
        col.autoIncrement ? 'AUTO_INCREMENT' : '',
        col.defaultValue !== undefined && col.defaultValue !== null ? `DEFAULT ${col.defaultValue}` : '',
        col.comment ? `\n${col.comment}` : '',
        '\nClick to sort',
      ].filter(Boolean).join('  ');
      cells.push(
        h(
          'div',
          { class: `hcell ${selected ? 'selected' : ''} ${col.numeric ? 'num' : ''}`, style: { width: `${this.widths[c]}px` }, title: tip, dataset: { c: String(c) } },
          h(
            'div.hname',
            null,
            col.pk ? icon('key', 'pk') : null,
            h('span.label', null, col.name),
            sorted ? icon(sorted === 'asc' ? 'arrow-up' : 'arrow-down', 'sort') : null,
          ),
          h('div.htype', null, col.type.toLowerCase()),
          h('div.resizer', { dataset: { resize: String(c) } }),
        ),
      );
    }
    this.header.replaceChildren(...cells);
    this.header.style.width = `${this.totalWidth}px`;
  }

  private render(): void {
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight - HEADER_H;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(this.view.length - 1, Math.ceil((top + height) / ROW_H) + OVERSCAN);
    const [c0, c1] = this.visibleCols();
    const sel = this.normSel();
    const frag = document.createDocumentFragment();
    for (let r = first; r <= last; r++) {
      const id = this.view[r];
      const isNew = id >= this.base.length;
      const isDeleted = this.deleted.has(id);
      const rowEdits = isNew ? null : this.edits.get(id);
      const rowSelected = sel && r >= sel.r0 && r <= sel.r1;
      const row = h('div', {
        class: `grid-row ${r % 2 ? 'odd' : ''} ${isNew ? 'new' : ''} ${isDeleted ? 'deleted' : ''} ${rowSelected && this.rowMode ? 'row-selected' : ''}`,
        style: { top: `${r * ROW_H}px`, width: `${this.totalWidth}px` },
      });
      row.append(
        h('div', { class: `cell rownum ${rowSelected ? 'active' : ''}`, dataset: { r: String(r), c: '-1' } }, isNew ? icon('add') : isDeleted ? icon('trash') : String(id + 1)),
        h('div', { style: { width: `${this.offsets[c0] ?? 0}px`, flex: 'none' } }),
      );
      for (let c = c0; c <= c1 && c < this.columns.length; c++) {
        const v = this.value(id, c);
        const col = this.columns[c];
        const inSel = sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
        const isFocus = this.sel && this.sel.r1 === r && this.sel.c1 === c;
        const modified = rowEdits?.has(c) || (isNew && this.insertedTouched[id - this.base.length]?.has(c));
        const cls = ['cell'];
        if (col.numeric) cls.push('num');
        if (v === null) cls.push('null');
        if (inSel) cls.push('selected');
        if (isFocus) cls.push('focus');
        if (modified) cls.push('modified');
        if (isNew && v === null && !this.insertedTouched[id - this.base.length]?.has(c)) cls.push('default');
        let text: string;
        if (v === null) {
          text = isNew && !this.insertedTouched[id - this.base.length]?.has(c) ? (col.autoIncrement ? 'auto' : col.defaultValue != null ? `default` : 'NULL') : 'NULL';
        } else {
          const s = String(v);
          text = s.length > 300 ? s.slice(0, 300) + '…' : s.replace(/\r?\n/g, '↵ ');
        }
        row.append(h('div', { class: cls.join(' '), style: { width: `${this.widths[c]}px` }, dataset: { r: String(r), c: String(c) } }, text));
      }
      frag.append(row);
    }
    this.body.replaceChildren(frag);
  }

  /* ------------------------------ selection ------------------------------ */

  private normSel(): Sel | null {
    if (!this.sel) return null;
    const { r0, c0, r1, c1 } = this.sel;
    return { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
  }

  private clampSel(): void {
    if (!this.sel) return;
    if (!this.view.length || !this.columns.length) {
      this.sel = null;
      return;
    }
    const maxR = this.view.length - 1;
    const maxC = this.columns.length - 1;
    this.sel = {
      r0: Math.min(this.sel.r0, maxR),
      r1: Math.min(this.sel.r1, maxR),
      c0: Math.min(this.sel.c0, maxC),
      c1: Math.min(this.sel.c1, maxC),
    };
  }

  selectAll(): void {
    if (!this.view.length) return;
    this.sel = { r0: 0, c0: 0, r1: this.view.length - 1, c1: this.columns.length - 1 };
    this.rowMode = true;
    this.afterSelect(false);
  }

  private afterSelect(scroll = true): void {
    this.renderHeader();
    this.render();
    if (scroll && this.sel) this.scrollIntoView(this.sel.r1, this.sel.c1);
    this.opts.onSelection?.();
  }

  private scrollIntoView(r: number, c: number): void {
    const s = this.scroller;
    const top = r * ROW_H;
    const viewH = s.clientHeight - HEADER_H;
    if (top < s.scrollTop) s.scrollTop = top;
    else if (top + ROW_H > s.scrollTop + viewH) s.scrollTop = top + ROW_H - viewH;
    if (c >= 0) {
      const left = this.offsets[c];
      const viewW = s.clientWidth - ROWNUM_W;
      if (left < s.scrollLeft) s.scrollLeft = left;
      else if (left + this.widths[c] > s.scrollLeft + viewW) s.scrollLeft = left + this.widths[c] - viewW;
    }
  }

  /** Summary of the current selection for the status bar. */
  selectionInfo(): { rows: number; cells: number; sum?: number; avg?: number; numericCount: number } | null {
    const s = this.normSel();
    if (!s) return null;
    let sum = 0;
    let n = 0;
    const cells = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
    if (cells <= 200000) {
      for (let r = s.r0; r <= s.r1; r++) {
        for (let c = s.c0; c <= s.c1; c++) {
          if (!this.columns[c].numeric) continue;
          const v = this.value(this.view[r], c);
          if (v !== null && v !== '' && Number.isFinite(Number(v))) {
            sum += Number(v);
            n++;
          }
        }
      }
    }
    return { rows: s.r1 - s.r0 + 1, cells, numericCount: n, sum: n ? sum : undefined, avg: n ? sum / n : undefined };
  }

  private cellFromEvent(e: MouseEvent): { r: number; c: number } | null {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.cell');
    if (!t || t.dataset.r === undefined) return null;
    return { r: Number(t.dataset.r), c: Number(t.dataset.c) };
  }

  private onMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (this.editor?.contains(target)) return;
    const resize = target.dataset.resize;
    if (resize !== undefined) {
      this.startResize(Number(resize), e);
      return;
    }
    const hcell = target.closest<HTMLElement>('.hcell');
    if (hcell?.dataset.c !== undefined) {
      if (e.button === 0) this.toggleSort(Number(hcell.dataset.c));
      return;
    }
    const cell = this.cellFromEvent(e);
    if (!cell) return;
    this.closeEditor(true);
    // Cells are re-rendered on mousedown, so the browser never fires click or
    // dblclick on them; detect the double click here instead.
    const now = Date.now();
    const last = this.lastDown;
    this.lastDown = { r: cell.r, c: cell.c, t: now };
    if (e.button === 0 && !e.shiftKey && cell.c >= 0 && last && last.r === cell.r && last.c === cell.c && now - last.t < 450) {
      this.lastDown = null;
      e.preventDefault();
      if (this.editable) this.openEditor(cell.r, cell.c);
      else void this.viewValue(cell.r, cell.c);
      return;
    }
    if (e.button === 2) {
      // Keep the selection if right-clicking inside it.
      const s = this.normSel();
      if (s && cell.r >= s.r0 && cell.r <= s.r1 && (cell.c < 0 || (cell.c >= s.c0 && cell.c <= s.c1))) return;
    }
    if (cell.c < 0) {
      this.rowMode = true;
      if (e.shiftKey && this.sel) this.sel = { ...this.sel, r1: cell.r, c0: 0, c1: this.columns.length - 1 };
      else this.sel = { r0: cell.r, r1: cell.r, c0: 0, c1: this.columns.length - 1 };
    } else {
      this.rowMode = false;
      if (e.shiftKey && this.sel) this.sel = { ...this.sel, r1: cell.r, c1: cell.c };
      else this.sel = { r0: cell.r, c0: cell.c, r1: cell.r, c1: cell.c };
    }
    this.dragging = e.button === 0;
    this.focus();
    this.afterSelect(false);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragging || !this.sel) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const t = el?.closest<HTMLElement>('.cell');
    if (!t || t.dataset.r === undefined) return;
    const r = Number(t.dataset.r);
    const c = Number(t.dataset.c);
    if (this.rowMode) {
      if (r !== this.sel.r1) {
        this.sel = { ...this.sel, r1: r };
        this.afterSelect(false);
      }
    } else if (c >= 0 && (r !== this.sel.r1 || c !== this.sel.c1)) {
      this.sel = { ...this.sel, r1: r, c1: c };
      this.afterSelect(false);
    }
  }

  private onDblClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.dataset.resize !== undefined) {
      this.autosize(Number(target.dataset.resize));
    }
  }

  private toggleSort(c: number): void {
    const cur = this.sort?.col === c ? this.sort.dir : null;
    const next: 'asc' | 'desc' | null = cur === null ? 'asc' : cur === 'asc' ? 'desc' : null;
    this.opts.onSort?.(c, next);
    this.sort = next ? { col: c, dir: next } : null;
    if (!this.serverSort) this.rebuildView();
    else this.renderHeader();
  }

  private startResize(c: number, e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = this.widths[c];
    document.body.classList.add('resizing');
    const move = (ev: MouseEvent) => {
      this.widths[c] = Math.max(40, startW + ev.clientX - startX);
      this.layoutColumns();
      this.body.style.width = `${this.totalWidth}px`;
      this.schedule();
    };
    const up = () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  private autosize(c: number): void {
    let w = this.textWidth(this.columns[c].name, true) + 44;
    for (const id of this.view.slice(0, 1000)) {
      const v = this.value(id, c);
      w = Math.max(w, this.textWidth(v === null ? 'NULL' : String(v).slice(0, 200)) + 20);
    }
    this.widths[c] = Math.round(Math.min(800, w));
    this.layoutColumns();
    this.body.style.width = `${this.totalWidth}px`;
    this.schedule();
  }

  /* ------------------------------ keyboard ------------------------------ */

  private onKey(e: KeyboardEvent): void {
    if (this.editor) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      this.copy(e.shiftKey ? 'tsv-headers' : 'tsv');
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v' && this.editable) {
      e.preventDefault();
      void navigator.clipboard.readText().then((t) => this.paste(t)).catch(() => undefined);
      return;
    }
    if (!this.sel) return;
    const maxR = this.view.length - 1;
    const maxC = this.columns.length - 1;
    const page = Math.max(1, Math.floor((this.scroller.clientHeight - HEADER_H) / ROW_H) - 1);
    let { r1, c1 } = this.sel;
    switch (e.key) {
      case 'ArrowUp': r1 = mod ? 0 : r1 - 1; break;
      case 'ArrowDown': r1 = mod ? maxR : r1 + 1; break;
      case 'ArrowLeft': c1 = mod ? 0 : c1 - 1; break;
      case 'ArrowRight': c1 = mod ? maxC : c1 + 1; break;
      case 'PageUp': r1 -= page; break;
      case 'PageDown': r1 += page; break;
      case 'Home': c1 = 0; if (mod) r1 = 0; break;
      case 'End': c1 = maxC; if (mod) r1 = maxR; break;
      case 'Tab': c1 += e.shiftKey ? -1 : 1; break;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (this.editable) this.openEditor(this.sel.r1, this.sel.c1);
        else this.viewValue(this.sel.r1, this.sel.c1);
        return;
      case 'Delete':
      case 'Backspace':
        if (this.editable) {
          e.preventDefault();
          if (this.rowMode) this.toggleDeleteSelected();
          else this.setSelected(null);
        }
        return;
      case 'Escape':
        return;
      default:
        // Typing starts editing, like a spreadsheet.
        if (this.editable && e.key.length === 1 && !mod && !e.altKey) {
          e.preventDefault();
          this.openEditor(this.sel.r1, this.sel.c1, e.key);
        }
        return;
    }
    e.preventDefault();
    r1 = Math.max(0, Math.min(maxR, r1));
    c1 = Math.max(0, Math.min(maxC, c1));
    if (e.shiftKey && e.key !== 'Tab') this.sel = { ...this.sel, r1, c1 };
    else this.sel = { r0: r1, c0: c1, r1, c1 };
    this.rowMode = false;
    this.afterSelect();
  }

  /* ------------------------------ editing ------------------------------ */

  private canEditCell(r: number, c: number): boolean {
    const id = this.view[r];
    if (!this.editable || this.deleted.has(id)) return false;
    const col = this.columns[c];
    return !(col.binary && id < this.base.length);
  }

  private openEditor(r: number, c: number, initial?: string): void {
    if (!this.canEditCell(r, c)) {
      this.viewValue(r, c);
      return;
    }
    this.closeEditor(false);
    this.scrollIntoView(r, c);
    const id = this.view[r];
    const col = this.columns[c];
    const cur = this.value(id, c);
    const text = cur === null ? '' : String(cur);
    if (text.length > 200 || text.includes('\n')) {
      void this.editInDialog(r, c);
      return;
    }
    let input: HTMLInputElement | HTMLSelectElement;
    if (col.options && !/^set\(/i.test(col.type)) {
      input = h('select', null, col.nullable ? h('option', { value: '\u0000' }, 'NULL') : null, col.options.map((o) => h('option', { value: o }, o)));
      input.value = cur === null ? '\u0000' : text;
    } else {
      input = h('input', { type: 'text', value: initial ?? text, placeholder: cur === null ? 'NULL' : '', spellcheck: false });
    }
    const wrap = h('div.cell-editor', {
      style: {
        top: `${HEADER_H + r * ROW_H}px`,
        left: `${ROWNUM_W + this.offsets[c]}px`,
        width: `${Math.max(this.widths[c], 160)}px`,
      },
    }, input, h('span.hint', null, 'Enter ✓  Esc ✕  Ctrl+0 NULL'));
    const commit = (move?: 'down' | 'right' | 'left') => {
      const raw = input.value;
      const v: Cell = input instanceof HTMLSelectElement && raw === '\u0000' ? null : raw;
      this.closeEditor(false);
      if (v !== cur || (v === '' && cur === null)) this.setValue(id, c, v);
      if (move && this.sel) {
        const nr = move === 'down' ? Math.min(this.view.length - 1, r + 1) : r;
        const nc = move === 'right' ? Math.min(this.columns.length - 1, c + 1) : move === 'left' ? Math.max(0, c - 1) : c;
        this.sel = { r0: nr, c0: nc, r1: nr, c1: nc };
        this.afterSelect();
      }
      this.focus();
    };
    input.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      ke.stopPropagation();
      if (ke.key === 'Enter') { ke.preventDefault(); commit('down'); }
      else if (ke.key === 'Tab') { ke.preventDefault(); commit(ke.shiftKey ? 'left' : 'right'); }
      else if (ke.key === 'Escape') { ke.preventDefault(); this.closeEditor(false); this.focus(); }
      else if ((ke.ctrlKey || ke.metaKey) && ke.key === '0') {
        ke.preventDefault();
        this.closeEditor(false);
        this.setValue(id, c, null);
        this.focus();
      }
    });
    input.addEventListener('blur', () => {
      if (this.editor === wrap) commit();
    });
    this.editor = wrap;
    this.scroller.append(wrap);
    input.focus();
    if (input instanceof HTMLInputElement && initial === undefined) input.select();
  }

  private closeEditor(commit: boolean): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    if (commit) {
      (ed.querySelector('input,select') as HTMLElement | null)?.blur();
    }
    ed.remove();
  }

  private setValue(id: number, c: number, v: Cell): void {
    if (id >= this.base.length) {
      const i = id - this.base.length;
      this.inserted[i][c] = v;
      this.insertedTouched[i].add(c);
    } else {
      const orig = this.base[id][c];
      let e = this.edits.get(id);
      if (orig === v || (orig !== null && v !== null && String(orig) === String(v))) {
        e?.delete(c);
        if (e && !e.size) this.edits.delete(id);
      } else {
        if (!e) this.edits.set(id, (e = new Map()));
        e.set(c, v);
      }
    }
    this.render();
    this.opts.onChange?.();
  }

  private setSelected(v: Cell): void {
    const s = this.normSel();
    if (!s) return;
    for (let r = s.r0; r <= s.r1; r++) {
      for (let c = s.c0; c <= s.c1; c++) {
        if (this.canEditCell(r, c)) {
          if (v === null && this.columns[c].nullable === false) continue;
          const id = this.view[r];
          if (id >= this.base.length) {
            this.inserted[id - this.base.length][c] = v;
            this.insertedTouched[id - this.base.length].add(c);
          } else this.setValueQuiet(id, c, v);
        }
      }
    }
    this.render();
    this.opts.onChange?.();
  }

  private setValueQuiet(id: number, c: number, v: Cell): void {
    const orig = this.base[id][c];
    let e = this.edits.get(id);
    if (orig === v) {
      e?.delete(c);
      if (e && !e.size) this.edits.delete(id);
      return;
    }
    if (!e) this.edits.set(id, (e = new Map()));
    e.set(c, v);
  }

  private paste(text: string): void {
    if (!this.sel || !text) return;
    const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).map((l) => l.split('\t'));
    const s = this.normSel()!;
    // A single value pastes into every selected cell.
    if (lines.length === 1 && lines[0].length === 1) {
      this.setSelected(lines[0][0]);
      return;
    }
    for (let i = 0; i < lines.length; i++) {
      const r = s.r0 + i;
      if (r >= this.view.length) break;
      for (let j = 0; j < lines[i].length; j++) {
        const c = s.c0 + j;
        if (c >= this.columns.length || !this.canEditCell(r, c)) continue;
        const id = this.view[r];
        const v = lines[i][j] === 'NULL' ? null : lines[i][j];
        if (id >= this.base.length) {
          this.inserted[id - this.base.length][c] = v;
          this.insertedTouched[id - this.base.length].add(c);
        } else this.setValueQuiet(id, c, v);
      }
    }
    this.render();
    this.opts.onChange?.();
  }

  addRow(copyFrom?: Cell[]): void {
    const values: Cell[] = this.columns.map((_, i) => (copyFrom ? copyFrom[i] : null));
    const touched = new Set<number>();
    if (copyFrom) {
      this.columns.forEach((col, i) => {
        if (!col.autoIncrement && !(col.pk && this.keyColumns.length === 1 && col.autoIncrement)) touched.add(i);
        if (col.autoIncrement) values[i] = null;
      });
    }
    this.inserted.push(values);
    this.insertedTouched.push(touched);
    this.rebuildView();
    const r = this.view.length - 1;
    const c = this.columns.findIndex((col) => !col.autoIncrement);
    this.sel = { r0: r, r1: r, c0: Math.max(0, c), c1: Math.max(0, c) };
    this.rowMode = false;
    this.afterSelect();
    this.opts.onChange?.();
    this.focus();
  }

  duplicateSelected(): void {
    const s = this.normSel();
    if (!s) return;
    for (let r = s.r0; r <= s.r1; r++) this.addRow(this.rowValues(this.view[r]));
  }

  toggleDeleteSelected(): void {
    const s = this.normSel();
    if (!s) return;
    const removeInserted: number[] = [];
    let allDeleted = true;
    for (let r = s.r0; r <= s.r1; r++) {
      const id = this.view[r];
      if (id < this.base.length && !this.deleted.has(id)) allDeleted = false;
    }
    for (let r = s.r0; r <= s.r1; r++) {
      const id = this.view[r];
      if (id >= this.base.length) removeInserted.push(id - this.base.length);
      else if (allDeleted) this.deleted.delete(id);
      else this.deleted.add(id);
    }
    for (const i of removeInserted.sort((a, b) => b - a)) {
      this.inserted.splice(i, 1);
      this.insertedTouched.splice(i, 1);
    }
    this.rebuildView();
    this.opts.onChange?.();
  }

  changeCount(): number {
    let n = this.deleted.size + this.inserted.length;
    for (const id of this.edits.keys()) if (!this.deleted.has(id)) n++;
    return n;
  }

  discardChanges(): void {
    this.edits.clear();
    this.deleted.clear();
    this.inserted = [];
    this.insertedTouched = [];
    this.rebuildView();
    this.opts.onChange?.();
  }

  getChanges(): RowChange[] {
    const keyIdx = this.keyColumns.map((k) => this.columns.findIndex((c) => c.name === k));
    const keyOf = (id: number) => Object.fromEntries(this.keyColumns.map((k, i) => [k, this.base[id][keyIdx[i]]]));
    const out: RowChange[] = [];
    for (const [id, e] of this.edits) {
      if (this.deleted.has(id) || !e.size) continue;
      out.push({ kind: 'update', key: keyOf(id), values: Object.fromEntries([...e].map(([c, v]) => [this.columns[c].name, v])) });
    }
    for (const id of [...this.deleted].sort((a, b) => a - b)) out.push({ kind: 'delete', key: keyOf(id) });
    this.inserted.forEach((row, i) => {
      out.push({ kind: 'insert', values: Object.fromEntries([...this.insertedTouched[i]].sort((a, b) => a - b).map((c) => [this.columns[c].name, row[c]])) });
    });
    return out;
  }

  /** Highlights the row of a failed change. */
  markFailed(index: number): void {
    const changes = this.getChanges();
    const ch = changes[index];
    if (!ch) return;
    let id = -1;
    if (ch.kind === 'insert') id = this.base.length + (index - changes.findIndex((x) => x.kind === 'insert'));
    else {
      const keyIdx = this.keyColumns.map((k) => this.columns.findIndex((c) => c.name === k));
      id = this.base.findIndex((row) => this.keyColumns.every((k, i) => row[keyIdx[i]] === ch.key[k]));
    }
    const r = this.view.indexOf(id);
    if (r >= 0) {
      this.sel = { r0: r, r1: r, c0: 0, c1: this.columns.length - 1 };
      this.rowMode = true;
      this.afterSelect();
    }
  }

  /* ------------------------------ value dialog ------------------------------ */

  private async viewValue(r: number, c: number): Promise<void> {
    const v = this.value(this.view[r], c);
    const col = this.columns[c];
    const text = v === null ? '' : prettyMaybeJson(String(v));
    const ta = h('textarea.value-view', { readOnly: true, value: text, rows: 16, spellcheck: false });
    const res = await modal({
      title: `${col.name}  ·  ${col.type}${v === null ? '  ·  NULL' : `  ·  ${String(v).length.toLocaleString()} chars`}`,
      icon: 'symbol-field',
      wide: true,
      body: ta,
      buttons: [
        { label: 'Open in Editor', value: 'open', kind: 'secondary' },
        { label: 'Copy', value: 'copy', kind: 'secondary' },
        { label: 'Close', value: '' },
      ],
    });
    if (res === 'copy') this.opts.onCopy(v === null ? '' : String(v));
    if (res === 'open') this.opts.onOpenText(text, looksJson(String(v ?? '')) ? 'json' : 'plaintext');
  }

  private async editInDialog(r: number, c: number): Promise<void> {
    if (!this.canEditCell(r, c)) {
      return this.viewValue(r, c);
    }
    const id = this.view[r];
    const v = this.value(id, c);
    const col = this.columns[c];
    const ta = h('textarea.value-view', { value: v === null ? '' : String(v), rows: 16, spellcheck: false });
    const nullBox = h('input', { type: 'checkbox', checked: v === null, disabled: col.nullable === false });
    const body = h('div.value-dialog', null, ta, h('label.null-toggle', null, nullBox, ' Set to NULL'));
    ta.addEventListener('input', () => (nullBox.checked = false));
    setTimeout(() => ta.focus());
    const res = await modal({
      title: `Edit ${col.name}  ·  ${col.type}`,
      icon: 'edit',
      wide: true,
      body,
      buttons: [
        { label: 'Format JSON', value: 'fmt', kind: 'secondary' },
        { label: 'Cancel', value: '', kind: 'secondary' },
        { label: 'Apply', value: 'ok' },
      ],
    });
    if (res === 'fmt') {
      this.setValue(id, c, prettyMaybeJson(ta.value));
      return this.editInDialog(r, c);
    }
    if (res === 'ok') this.setValue(id, c, nullBox.checked ? null : ta.value);
    this.focus();
  }

  /* ------------------------------ copy ------------------------------ */

  private selectedData(): { cols: ColumnInfo[]; rows: Cell[][] } | null {
    const s = this.normSel();
    if (!s) return null;
    const cols = this.columns.slice(s.c0, s.c1 + 1);
    const rows: Cell[][] = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const vals = this.rowValues(this.view[r]);
      rows.push(vals.slice(s.c0, s.c1 + 1));
    }
    return { cols, rows };
  }

  copy(fmt: CopyFormat | 'tsv-headers'): void {
    const d = this.selectedData();
    if (!d) return;
    this.opts.onCopy(formatRows(fmt, d.cols, d.rows, this.tableName));
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const cell = this.cellFromEvent(e);
    if (!cell) return;
    const c = cell.c >= 0 ? cell.c : 0;
    const id = this.view[cell.r];
    const v = this.value(id, c);
    const col = this.columns[c];
    const ed = this.editable;
    const items: (MenuItem | null)[] = [
      { label: 'Copy', icon: 'copy', key: 'Ctrl+C', run: () => this.copy('tsv') },
      { label: 'Copy with Headers', key: 'Ctrl+Shift+C', run: () => this.copy('tsv-headers') },
      { label: 'Copy as CSV', run: () => this.copy('csv') },
      { label: 'Copy as JSON', icon: 'json', run: () => this.copy('json') },
      { label: 'Copy as SQL INSERT', icon: 'database', run: () => this.copy('sql') },
      { label: 'Copy as Markdown', icon: 'markdown', run: () => this.copy('markdown') },
      { label: 'Copy as IN (…) list', run: () => this.copy('in') },
      null,
      { label: 'View Value…', icon: 'eye', key: ed ? '' : 'Enter', run: () => void this.viewValue(cell.r, c) },
    ];
    if (this.opts.onFilterByValue && cell.c >= 0) {
      items.push(
        { label: `Filter: ${col.name} = ${v === null ? 'NULL' : truncate(String(v), 24)}`, icon: 'filter', run: () => this.opts.onFilterByValue!(col, v, '=') },
        { label: `Filter: ${col.name} ≠ ${v === null ? 'NULL' : truncate(String(v), 24)}`, run: () => this.opts.onFilterByValue!(col, v, '<>') },
      );
    }
    if (ed) {
      items.push(
        null,
        { label: 'Edit Cell', icon: 'edit', key: 'Enter', disabled: !this.canEditCell(cell.r, c), run: () => this.openEditor(cell.r, c) },
        { label: 'Edit in Dialog…', disabled: !this.canEditCell(cell.r, c), run: () => void this.editInDialog(cell.r, c) },
        { label: 'Set to NULL', key: 'Ctrl+0', disabled: col.nullable === false, run: () => this.setSelected(null) },
        { label: 'Set to Empty String', run: () => this.setSelected('') },
        null,
        { label: 'Add Row', icon: 'add', run: () => this.addRow() },
        { label: 'Duplicate Row(s)', icon: 'files', run: () => this.duplicateSelected() },
        { label: this.deleted.has(id) ? 'Restore Row(s)' : 'Delete Row(s)', icon: 'trash', key: 'Delete', run: () => this.toggleDeleteSelected() },
      );
    }
    contextMenu(e.clientX, e.clientY, items);
  }
}

/* ------------------------------ helpers ------------------------------ */

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function looksJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function prettyMaybeJson(s: string): string {
  if (!looksJson(s)) return s;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function sqlLit(v: Cell, col: ColumnInfo): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (col.numeric && /^-?\d+(\.\d+)?$/.test(v)) return v;
  if (col.binary && /^0x[0-9a-f]+$/i.test(v)) return `X'${v.slice(2)}'`;
  return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0') + "'";
}

function csvVal(v: Cell, sep: string): string {
  if (v === null) return '';
  const s = String(v);
  return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

export function formatRows(fmt: CopyFormat | 'tsv-headers', cols: ColumnInfo[], rows: Cell[][], table: string): string {
  const qid = (s: string) => '`' + s.replace(/`/g, '``') + '`';
  switch (fmt) {
    case 'tsv':
    case 'tsv-headers': {
      const body = rows.map((r) => r.map((v) => (v === null ? 'NULL' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '))).join('\t'));
      return (fmt === 'tsv-headers' ? [cols.map((c) => c.name).join('\t'), ...body] : body).join('\n');
    }
    case 'csv':
      return [cols.map((c) => csvVal(c.name, ',')).join(','), ...rows.map((r) => r.map((v) => csvVal(v, ',')).join(','))].join('\n');
    case 'json':
      return JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, c.numeric && typeof r[i] === 'string' && Number.isSafeInteger(Number(r[i])) ? Number(r[i]) : r[i]]))), null, 2);
    case 'sql':
      return rows.map((r) => `INSERT INTO ${qid(table)} (${cols.map((c) => qid(c.name)).join(', ')}) VALUES (${r.map((v, i) => sqlLit(v, cols[i])).join(', ')});`).join('\n');
    case 'markdown': {
      const esc = (v: Cell) => (v === null ? '*NULL*' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
      return [`| ${cols.map((c) => c.name).join(' | ')} |`, `|${cols.map((c) => (c.numeric ? ' ---: ' : ' --- ')).join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
    }
    case 'in': {
      const vals = [...new Set(rows.flatMap((r) => r.map((v, i) => sqlLit(v, cols[i]))))];
      return `(${vals.join(', ')})`;
    }
  }
}
