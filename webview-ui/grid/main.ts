import './grid.css';
import type { SchemaInfo, ExportFormat, GridToExtension, GridToWebview, ResultSet, SortSpec, TablePage } from '../../src/shared/protocol';
import { contextMenu, formatMs, formatNumber, h, icon, iconButton, modal, toast, vscode } from '../common/dom';
import { DataGrid } from './datagrid';
import { SqlEditor } from './sqleditor';

const api = vscode();
const send = (m: GridToExtension) => api.postMessage(m);
const app = document.getElementById('app')!;

const EXPORTS: { format: ExportFormat; label: string; icon: string }[] = [
  { format: 'csv', label: 'CSV', icon: 'file' },
  { format: 'tsv', label: 'TSV', icon: 'file' },
  { format: 'xlsx', label: 'Excel (.xlsx)', icon: 'table' },
  { format: 'json', label: 'JSON', icon: 'json' },
  { format: 'sql', label: 'SQL INSERT', icon: 'database' },
  { format: 'markdown', label: 'Markdown', icon: 'markdown' },
];

function exportMenu(anchor: HTMLElement, onPick: (f: ExportFormat) => void): void {
  const r = anchor.getBoundingClientRect();
  contextMenu(
    r.left,
    r.bottom + 2,
    EXPORTS.map((e) => ({ label: e.label, icon: e.icon, run: () => onPick(e.format) })),
  );
}

function selectionText(grid: DataGrid): string {
  const s = grid.selectionInfo();
  if (!s || s.cells <= 1) return '';
  const parts = [`${formatNumber(s.rows)} row${s.rows === 1 ? '' : 's'}`, `${formatNumber(s.cells)} cells`];
  if (s.sum !== undefined && s.numericCount > 1) {
    parts.push(`Sum ${fmtNum(s.sum)}`, `Avg ${fmtNum(s.avg!)}`);
  }
  return parts.join(' · ');
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

const gridCallbacks = {
  onCopy: (text: string) => send({ type: 'copy', text }),
  onOpenText: (text: string, language: string) => send({ type: 'openText', text, language }),
};

/* ====================================================================== */
/* Results mode                                                            */
/* ====================================================================== */

class ResultsView {
  private results: ResultSet[] = [];
  private active: number | 'messages' = 'messages';
  private running = false;
  private shownId = -1;
  private startedAt = 0;
  private timer = 0;
  private readonly title = h('span.title');
  private readonly subtitle = h('span.subtitle.mono');
  private readonly statusChip = h('span.status-chip');
  private readonly cancelBtn = h('button.btn.secondary.small', { onclick: () => send({ type: 'cancel' }) }, icon('debug-stop'), 'Cancel');
  private readonly tabs = h('div.tabs', { role: 'tablist' });
  private readonly search = h('input.search', { type: 'text', placeholder: 'Search in results', spellcheck: false });
  private readonly content = h('div.content');
  private readonly statusLeft = h('span');
  private readonly statusRight = h('span');
  private readonly grid = new DataGrid({ ...gridCallbacks, onSelection: () => this.updateStatus() });
  private readonly messages = h('div.messages');

  constructor() {
    this.search.addEventListener('input', () => {
      this.grid.setQuickFilter(this.search.value);
      this.updateStatus();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.search.value = '';
        this.grid.setQuickFilter('');
        this.grid.focus();
      }
    });
    const exportBtn: HTMLButtonElement = iconButton('cloud-upload', 'Export result', () => exportMenu(exportBtn, (format) => send({ type: 'export', format, resultId: typeof this.active === 'number' ? this.results[this.active]?.id : undefined })), 'Export');
    this.cancelBtn.hidden = true;
    app.replaceChildren(
      h(
        'div.page',
        null,
        h('div.toolbar.top', null, icon('database', 'title-icon'), this.title, this.subtitle, h('span.spacer'), this.statusChip, this.cancelBtn, iconButton('refresh', 'Run again', () => send({ type: 'rerun' }))),
        h('div.tabbar', null, this.tabs, h('span.spacer'), h('div.search-wrap', null, icon('search'), this.search), exportBtn),
        this.content,
        h('div.statusbar', null, this.statusLeft, h('span.spacer'), this.statusRight),
      ),
    );
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        this.search.focus();
        this.search.select();
      }
    });
    this.render();
  }

  init(title: string, subtitle: string): void {
    this.title.textContent = title;
    this.subtitle.textContent = subtitle;
    this.subtitle.title = subtitle;
    this.results = [];
    this.active = 'messages';
    this.search.value = '';
    this.render();
  }

  running_(label: string): void {
    this.running = true;
    this.startedAt = Date.now();
    this.cancelBtn.hidden = false;
    clearInterval(this.timer);
    const tick = () => {
      this.statusChip.replaceChildren(icon('loading', 'spin'), ` ${label} ${formatMs(Date.now() - this.startedAt)}`);
    };
    tick();
    this.timer = window.setInterval(tick, 100);
    this.statusChip.className = 'status-chip running';
    this.render();
  }

  add(r: ResultSet): void {
    this.results.push(r);
    const firstRows = this.results.findIndex((x) => x.kind === 'rows');
    if (r.kind === 'rows' && firstRows === this.results.length - 1) {
      this.active = this.results.length - 1;
    }
    if (r.kind === 'error') {
      this.active = 'messages';
    }
    this.render();
  }

  done(cancelled: boolean, ms: number): void {
    this.running = false;
    clearInterval(this.timer);
    this.cancelBtn.hidden = true;
    const failed = this.results.some((r) => r.kind === 'error');
    this.statusChip.className = `status-chip ${cancelled ? 'warn' : failed ? 'error' : 'ok'}`;
    this.statusChip.replaceChildren(icon(cancelled ? 'debug-stop' : failed ? 'error' : 'check'), ` ${cancelled ? 'Cancelled' : failed ? 'Failed' : 'Done'} · ${formatMs(ms)}`);
    if (!this.results.some((r) => r.kind === 'rows')) {
      this.active = 'messages';
    }
    this.render();
  }

  private render(): void {
    const rowsResults = this.results.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'rows');
    const tabs = rowsResults.map(({ r, i }, n) =>
      h(
        'button',
        { class: `tab ${this.active === i ? 'active' : ''}`, role: 'tab', title: r.sql, onclick: () => this.select(i) },
        icon('table'),
        `Result ${n + 1}`,
        h('span.badge', null, formatNumber(r.totalRows)),
      ),
    );
    const errors = this.results.filter((r) => r.kind === 'error').length;
    tabs.push(
      h(
        'button',
        { class: `tab ${this.active === 'messages' ? 'active' : ''}`, role: 'tab', onclick: () => this.select('messages') },
        icon(errors ? 'error' : 'output'),
        'Messages',
        errors ? h('span.badge.err', null, String(errors)) : null,
      ),
    );
    this.tabs.replaceChildren(...tabs);

    if (this.active === 'messages') {
      this.renderMessages();
      this.content.replaceChildren(this.messages);
      this.search.disabled = true;
    } else {
      const r = this.results[this.active];
      if (this.content.firstChild !== this.grid.el) {
        this.content.replaceChildren(this.grid.el);
      }
      if (this.shownId !== r.id) {
        this.shownId = r.id;
        this.grid.setData(r.columns, r.rows, { tableName: r.columns[0]?.table });
        this.grid.setQuickFilter(this.search.value);
      }
      this.search.disabled = false;
    }
    this.updateStatus();
  }

  private select(i: number | 'messages'): void {
    this.active = i;
    this.render();
    if (i !== 'messages') this.grid.focus();
  }

  private renderMessages(): void {
    if (!this.results.length) {
      this.messages.replaceChildren(
        this.running
          ? h('div.empty', null, icon('loading', 'spin'), 'Running…')
          : h('div.empty', null, icon('play'), h('div', null, 'Run a query with ', h('kbd', null, 'Ctrl+Enter'), ' (statement at cursor) or ', h('kbd', null, 'Ctrl+Shift+Enter'), ' (all).')),
      );
      return;
    }
    this.messages.replaceChildren(
      ...this.results.map((r) => {
        let msg: HTMLElement;
        if (r.kind === 'error') {
          msg = h('div.error-box', null, r.error ?? 'Error');
        } else if (r.kind === 'rows') {
          msg = h('div.msg-text', null, `${formatNumber(r.totalRows)} row${r.totalRows === 1 ? '' : 's'} returned${r.truncated ? ` (showing first ${formatNumber(r.rows.length)})` : ''}`);
        } else {
          const parts = [`${formatNumber(r.affectedRows ?? 0)} row${r.affectedRows === 1 ? '' : 's'} affected`];
          if (r.insertId) parts.push(`insert id ${r.insertId}`);
          if (r.warnings) parts.push(`${r.warnings} warning${r.warnings === 1 ? '' : 's'}`);
          if (r.info) parts.push(r.info.trim());
          msg = h('div.msg-text', null, parts.join(' · '));
        }
        return h(
          'div',
          { class: `msg ${r.kind}` },
          icon(r.kind === 'error' ? 'error' : r.kind === 'rows' ? 'table' : 'check'),
          h('div.msg-main', null, h('pre.msg-sql', { title: 'Click to copy', onclick: () => send({ type: 'copy', text: r.sql }) }, r.sql), msg),
          h('span.muted.msg-time', null, formatMs(r.durationMs)),
        );
      }),
    );
  }

  private updateStatus(): void {
    if (this.active === 'messages') {
      const ok = this.results.filter((r) => r.kind !== 'error').length;
      this.statusLeft.textContent = this.results.length ? `${ok} of ${this.results.length} statement result${this.results.length === 1 ? '' : 's'} succeeded` : '';
      this.statusRight.textContent = '';
      return;
    }
    const r = this.results[this.active];
    const shown = this.grid.visibleRowCount;
    const parts = [`${formatNumber(r.totalRows)} row${r.totalRows === 1 ? '' : 's'}`, `${r.columns.length} columns`, formatMs(r.durationMs)];
    if (this.search.value.trim()) parts.unshift(`${formatNumber(shown)} matching`);
    this.statusLeft.replaceChildren(
      document.createTextNode(parts.join(' · ')),
      r.truncated ? h('span.warn-text', null, icon('warning'), ` showing first ${formatNumber(r.rows.length)} — raise "mysqlLens.maxRows" or add LIMIT`) : '',
    );
    this.statusRight.textContent = selectionText(this.grid);
  }
}

/* ====================================================================== */
/* Table mode                                                              */
/* ====================================================================== */

class TableView {
  private page: TablePage | null = null;
  private readOnly = false;
  private loading = false;
  private requestId = 0;
  private pendingPreview: ((stmts: string[]) => void) | null = null;
  private sort: SortSpec | null = null;
  private filter = '';
  private readonly editor: SqlEditor;

  private readonly title = h('span.title');
  private readonly subtitle = h('span.subtitle');
  private readonly errorBar = h('div.error-bar');
  private readonly content = h('div.content');
  private readonly statusLeft = h('span');
  private readonly statusMid = h('span.muted');
  private readonly statusRight = h('span');
  private readonly pager = h('div.pager');
  private readonly saveBtn = h('button.btn.small', { onclick: () => this.save(), title: 'Save changes (Ctrl+S)' }, icon('save'), h('span', null, 'Save'));
  private readonly discardBtn = h('button.btn.secondary.small', { onclick: () => this.discard(), title: 'Discard all changes' }, icon('discard'), 'Discard');
  private readonly editButtons: HTMLElement;
  private readonly grid: DataGrid;
  private readonly loadingBar = h('div.loading-bar');

  constructor() {
    this.grid = new DataGrid({
      ...gridCallbacks,
      serverSort: true,
      onSort: (c, dir) => {
        if (!this.page) return;
        this.sort = dir ? { column: this.page.columns[c].name, dir } : null;
        void this.load(0);
      },
      onChange: () => this.updateChanges(),
      onSelection: () => (this.statusRight.textContent = selectionText(this.grid)),
      onFilterByValue: (col, v, op) => {
        if (this.page?.custom) {
          toast('Filtering by value works on table data. Edit the query instead.', 'warn');
          return;
        }
        const q = '`' + col.name.replace(/`/g, '``') + '`';
        const cond = v === null ? `${q} IS ${op === '=' ? '' : 'NOT '}NULL` : `${q} ${op} ${typeof v === 'number' || (col.numeric && /^-?\d+(\.\d+)?$/.test(v)) ? v : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`}`;
        this.filter = this.filter.trim() ? `${this.filter.trim()} AND ${cond}` : cond;
        void this.load(0);
      },
    });

    this.editor = new SqlEditor({
      placeholder: 'SELECT * FROM table WHERE …   (Ctrl+Enter to run, Ctrl+Space for suggestions)',
      onRun: (sql) => void this.runQuery(sql),
    });

    const exportBtn: HTMLButtonElement = iconButton('cloud-upload', 'Export table (uses the current filter and sort, all pages)', () => exportMenu(exportBtn, (format) => send({ type: 'export', format })), 'Export');

    this.editButtons = h(
      'div.edit-buttons',
      null,
      iconButton('add', 'Add row', () => this.grid.addRow(), 'Add'),
      iconButton('files', 'Duplicate selected rows', () => this.grid.duplicateSelected()),
      iconButton('trash', 'Delete selected rows (Delete)', () => this.grid.toggleDeleteSelected()),
      h('span.sep'),
      this.saveBtn,
      this.discardBtn,
    );

    app.replaceChildren(
      h(
        'div.page',
        null,
        h(
          'div.toolbar.top',
          null,
          icon('table', 'title-icon'),
          this.title,
          this.subtitle,
          h('span.spacer'),
          iconButton('discard', 'Reset query to the whole table', () => {
            this.filter = '';
            this.sort = null;
            void this.load(0);
          }),
          iconButton('refresh', 'Reload (F5)', () => void this.reload()),
        ),
        h(
          'div.query-row',
          null,
          this.editor.el,
          h('button.btn.run-btn', { title: 'Run query (Ctrl+Enter)', onclick: () => void this.runQuery(this.editor.value) }, icon('play'), 'Run'),
        ),
        h('div.toolbar.second', null, this.editButtons, h('span.spacer'), exportBtn),
        this.loadingBar,
        this.errorBar,
        this.content,
        h('div.statusbar', null, this.statusLeft, this.pager, this.statusMid, h('span.spacer'), this.statusRight),
      ),
    );
    this.content.append(this.grid.el);
    this.errorBar.hidden = true;

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.save();
      } else if (e.key === 'F5') {
        e.preventDefault();
        void this.reload();
      } else if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        this.editor.focus();
      }
    });
    this.updateChanges();
  }

  init(title: string, subtitle: string, readOnly: boolean): void {
    this.title.textContent = title;
    this.subtitle.textContent = subtitle;
    this.readOnly = readOnly;
  }

  private async confirmDiscard(): Promise<boolean> {
    const n = this.grid.changeCount();
    if (!n) return true;
    const r = await modal({
      title: 'Unsaved changes',
      icon: 'warning',
      body: h('p', null, `You have ${n} unsaved change${n === 1 ? '' : 's'}. Discard ${n === 1 ? 'it' : 'them'}?`),
      buttons: [
        { label: 'Keep Editing', value: '', kind: 'secondary' },
        { label: 'Discard', value: 'discard', kind: 'danger' },
      ],
    });
    return r === 'discard';
  }

  setSchema(s: SchemaInfo): void {
    this.editor.setSchema(s);
  }

  async load(page = this.page?.page ?? 0, pageSize = this.page && !this.page.custom ? this.page.pageSize : 200): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.loading = true;
    this.loadingBar.classList.add('on');
    send({ type: 'loadPage', page, pageSize, sort: this.sort, filter: this.filter });
  }

  private async runQuery(sql: string): Promise<void> {
    if (!sql.trim()) return;
    if (!(await this.confirmDiscard())) return;
    this.loading = true;
    this.loadingBar.classList.add('on');
    send({ type: 'runQuery', sql });
  }

  private async reload(): Promise<void> {
    if (this.page?.custom) await this.runQuery(this.page.query);
    else await this.load();
  }

  queryDone(message: string): void {
    this.loading = false;
    this.loadingBar.classList.remove('on');
    this.errorBar.hidden = true;
    toast(message);
  }

  setPage(p: TablePage): void {
    const same = this.page && this.page.page === p.page && this.page.filter === p.filter && JSON.stringify(this.page.sort) === JSON.stringify(p.sort);
    this.page = p;
    this.loading = false;
    this.loadingBar.classList.remove('on');
    this.errorBar.hidden = true;
    this.sort = p.sort;
    this.filter = p.filter;
    this.grid.setServerSort(!p.custom);
    if (!this.editor.focused || p.custom) this.editor.value = p.query;
    const sortCol = p.sort ? p.columns.findIndex((c) => c.name === p.sort!.column) : -1;
    const editable = !this.readOnly && p.keyColumns.length > 0;
    this.grid.setData(p.columns, p.rows, {
      editable,
      keyColumns: p.keyColumns,
      sort: sortCol >= 0 ? { col: sortCol, dir: p.sort!.dir } : null,
      keepScroll: !!same && !p.custom,
      tableName: p.columns[0]?.table,
    });
    this.editButtons.hidden = !editable;
    if (p.custom) {
      this.statusLeft.textContent = `${formatNumber(p.total)} row${p.total === 1 ? '' : 's'} · ${p.columns.length} columns · ${formatMs(p.durationMs)}`;
      this.pager.replaceChildren();
    } else {
      const from = p.total ? p.page * p.pageSize + 1 : 0;
      const to = Math.min(p.total, (p.page + 1) * p.pageSize);
      this.statusLeft.textContent = `${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(p.total)} rows · ${formatMs(p.durationMs)}`;
      this.renderPager();
    }
    this.statusMid.replaceChildren(p.readOnlyReason ? h('span', { title: p.readOnlyReason }, icon('lock'), p.custom ? ' Query result · read-only' : ' Read-only') : '');
    this.updateChanges();
  }

  pageError(message: string): void {
    this.loading = false;
    this.loadingBar.classList.remove('on');
    this.errorBar.hidden = false;
    this.errorBar.replaceChildren(icon('error'), h('span.mono', null, message), h('span.spacer'), iconButton('close', 'Dismiss', () => (this.errorBar.hidden = true)));
    this.editor.focus();
  }

  private renderPager(): void {
    const p = this.page!;
    const pages = Math.max(1, Math.ceil(p.total / p.pageSize));
    const go = (n: number) => void this.load(Math.max(0, Math.min(pages - 1, n)));
    const input = h('input.page-input', { type: 'text', value: String(p.page + 1), title: 'Page' });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go(Number(input.value) - 1);
    });
    const size = h('select.page-size', { title: 'Rows per page' }, [50, 100, 200, 500, 1000, 5000].map((n) => h('option', { value: String(n), selected: n === p.pageSize }, `${n} / page`)));
    size.addEventListener('change', () => void this.load(0, Number(size.value)));
    const btn = (ic: string, title: string, disabled: boolean, fn: () => void) => {
      const b = iconButton(ic, title, fn);
      b.disabled = disabled;
      return b;
    };
    this.pager.replaceChildren(
      btn('arrow-left', 'First page', p.page === 0, () => go(0)),
      btn('chevron-left', 'Previous page', p.page === 0, () => go(p.page - 1)),
      input,
      h('span.muted', null, `/ ${formatNumber(pages)}`),
      btn('chevron-right', 'Next page', p.page >= pages - 1, () => go(p.page + 1)),
      btn('arrow-right', 'Last page', p.page >= pages - 1, () => go(pages - 1)),
      size,
    );
  }

  private updateChanges(): void {
    const n = this.grid.changeCount();
    this.saveBtn.disabled = n === 0;
    this.discardBtn.disabled = n === 0;
    (this.saveBtn.lastChild as HTMLElement).textContent = n ? `Save (${n})` : 'Save';
  }

  private discard(): void {
    this.grid.discardChanges();
  }

  private save(): void {
    if (!this.grid.changeCount() || this.loading) return;
    const changes = this.grid.getChanges();
    const id = ++this.requestId;
    this.pendingPreview = async (stmts) => {
      const code = h('pre.sql-preview.mono', null, stmts.join('\n'));
      const r = await modal({
        title: `Save ${stmts.length} change${stmts.length === 1 ? '' : 's'}`,
        icon: 'save',
        wide: true,
        body: h('div', null, h('p.muted', null, 'These statements run in one transaction. If one fails, nothing is saved.'), code),
        buttons: [
          { label: 'Copy SQL', value: 'copy', kind: 'secondary' },
          { label: 'Cancel', value: '', kind: 'secondary' },
          { label: 'Apply', value: 'apply' },
        ],
      });
      if (r === 'copy') send({ type: 'copy', text: stmts.join('\n') });
      if (r === 'apply') {
        this.loadingBar.classList.add('on');
        send({ type: 'applyChanges', changes });
      }
    };
    send({ type: 'previewChanges', changes, requestId: id });
  }

  preview(stmts: string[], requestId: number): void {
    if (requestId === this.requestId && this.pendingPreview) {
      const fn = this.pendingPreview;
      this.pendingPreview = null;
      fn(stmts);
    }
  }

  applied(ok: boolean, message?: string, failedIndex?: number): void {
    this.loadingBar.classList.remove('on');
    if (ok) {
      this.grid.discardChanges();
      toast(message ?? 'Saved');
    } else {
      if (failedIndex !== undefined) this.grid.markFailed(failedIndex);
      void modal({ title: 'Changes were not saved', icon: 'error', body: h('div.error-box', null, message ?? 'Unknown error'), buttons: [{ label: 'OK', value: '' }] });
    }
  }
}

/* ====================================================================== */

let results: ResultsView | null = null;
let table: TableView | null = null;

window.addEventListener('message', (ev: MessageEvent<GridToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      if (m.mode === 'results') {
        results ??= new ResultsView();
        results.init(m.title, m.subtitle);
      } else {
        table ??= new TableView();
        table.init(m.title, m.subtitle, m.readOnly);
      }
      break;
    case 'running':
      results?.running_(m.label);
      break;
    case 'result':
      results?.add(m.result);
      break;
    case 'done':
      results?.done(m.cancelled, m.durationMs);
      break;
    case 'page':
      table?.setPage(m.page);
      break;
    case 'pageError':
      table?.pageError(m.message);
      break;
    case 'preview':
      table?.preview(m.statements, m.requestId);
      break;
    case 'applied':
      table?.applied(m.ok, m.message, m.failedIndex);
      break;
    case 'schema':
      table?.setSchema(m.schema);
      break;
    case 'queryDone':
      table?.queryDone(m.message);
      break;
  }
});

app.append(h('div.empty', null, icon('loading', 'spin'), 'Loading…'));
send({ type: 'ready' });
