import './importer.css';
import type { ColumnInfo, ImportPlan, ImportPreview, ImportTarget, ImportToExtension, ImportToWebview } from '../../src/shared/protocol';
import { h, icon, vscode } from '../common/dom';

const api = vscode();
const send = (m: ImportToExtension) => api.postMessage(m);
const app = document.getElementById('app')!;

interface State {
  target: ImportTarget | null;
  preview: ImportPreview | null;
  previewError: string;
  createTable: boolean;
  table: string;
  newTable: string;
  tableColumns: ColumnInfo[];
  mapping: Record<string, number>;
  newCols: { include: boolean; name: string; type: string }[];
  mode: ImportPlan['mode'];
  truncateFirst: boolean;
  emptyAsNull: boolean;
  batchSize: number;
  running: boolean;
  progress: string;
  result: { ok: boolean; message: string } | null;
}

const s: State = {
  target: null,
  preview: null,
  previewError: '',
  createTable: false,
  table: '',
  newTable: '',
  tableColumns: [],
  mapping: {},
  newCols: [],
  mode: 'insert',
  truncateFirst: false,
  emptyAsNull: true,
  batchSize: 500,
  running: false,
  progress: '',
  result: null,
};

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');

function autoMap(): void {
  const src = s.preview?.sourceColumns ?? [];
  s.mapping = {};
  for (const c of s.tableColumns) {
    const i = src.findIndex((x) => norm(x) === norm(c.name));
    s.mapping[c.name] = i;
  }
  // Fall back to position when nothing matched by name.
  if (s.tableColumns.length && Object.values(s.mapping).every((v) => v < 0)) {
    s.tableColumns.forEach((c, i) => (s.mapping[c.name] = !c.autoIncrement && i < src.length ? i : -1));
  }
}

function initNewCols(): void {
  const p = s.preview;
  if (!p) return;
  const seen = new Set<string>();
  s.newCols = p.sourceColumns.map((c, i) => {
    let name = c.trim().replace(/\s+/g, '_').replace(/[^\w$]/g, '').slice(0, 64) || `column_${i + 1}`;
    while (seen.has(name.toLowerCase())) name += '_';
    seen.add(name.toLowerCase());
    return { include: true, name, type: p.inferredTypes[i] };
  });
  if (!s.newTable) s.newTable = p.fileName.replace(/\.[^.]+$/, '').replace(/[^\w$]/g, '_').toLowerCase().slice(0, 64);
}

function card(n: number, title: string, body: (HTMLElement | null)[], disabled = false): HTMLElement {
  return h('section', { class: `card ${disabled ? 'disabled' : ''}` }, h('div.card-head', null, h('span.step', null, String(n)), h('span.card-title', null, title)), disabled ? null : h('div.card-body', null, body));
}

function select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void, attrs: Record<string, unknown> = {}): HTMLSelectElement {
  const el = h('select', attrs, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function sourceCard(): HTMLElement {
  const p = s.preview;
  const fileBtn = h('button.btn', { onclick: () => send({ type: 'pickFile' }), disabled: s.running }, icon('folder-opened'), p ? 'Choose Another File…' : 'Choose File…');
  const body: (HTMLElement | null)[] = [
    h('div.file-row', null, fileBtn, p ? h('span.file-name', null, icon(p.fileKind === 'xlsx' ? 'table' : p.fileKind === 'json' ? 'json' : 'file'), p.fileName, h('span.muted', null, ` · ${p.rowCountHint}`)) : h('span.muted', null, 'CSV, TSV, JSON / JSON Lines or Excel (.xlsx)')),
  ];
  if (s.previewError) body.push(h('div.error-box', null, s.previewError));
  if (p) {
    const o = { ...p.options };
    const reparse = () => send({ type: 'reparse', options: o });
    const opts: HTMLElement[] = [];
    if (p.fileKind === 'csv') {
      opts.push(
        h('label.opt', null, 'Delimiter', select([{ value: ',', label: 'Comma ,' }, { value: ';', label: 'Semicolon ;' }, { value: '\t', label: 'Tab' }, { value: '|', label: 'Pipe |' }], o.delimiter, (v) => { o.delimiter = v; reparse(); })),
        h('label.opt', null, 'Quote', select([{ value: '"', label: 'Double "' }, { value: "'", label: "Single '" }], o.quote, (v) => { o.quote = v; reparse(); })),
        h('label.opt', null, 'Encoding', select([{ value: 'utf8', label: 'UTF-8' }, { value: 'latin1', label: 'Latin-1 / Windows-1252' }, { value: 'utf16le', label: 'UTF-16 LE' }], o.encoding, (v) => { o.encoding = v; reparse(); })),
      );
    }
    if (p.fileKind === 'xlsx' && p.sheets && p.sheets.length > 1) {
      opts.push(h('label.opt', null, 'Sheet', select(p.sheets.map((x) => ({ value: x, label: x })), o.sheet ?? p.sheets[0], (v) => { o.sheet = v; reparse(); })));
    }
    if (p.fileKind !== 'json') {
      const cb = h('input', { type: 'checkbox', checked: o.header });
      cb.addEventListener('change', () => { o.header = cb.checked; reparse(); });
      opts.push(h('label.opt.check', null, cb, 'First row is a header'));
    }
    if (opts.length) body.push(h('div.opts', null, opts));
    body.push(previewTable(p));
  }
  return card(1, 'Source file', body);
}

function previewTable(p: ImportPreview): HTMLElement {
  const rows = p.rows.slice(0, 50);
  return h(
    'div.preview-wrap',
    null,
    h(
      'table.preview',
      null,
      h('thead', null, h('tr', null, h('th.idx', null, '#'), p.sourceColumns.map((c, i) => h('th', { title: p.inferredTypes[i] }, c, h('span.ptype', null, p.inferredTypes[i].toLowerCase()))))),
      h('tbody', null, rows.map((r, i) => h('tr', null, h('td.idx', null, String(i + 1)), p.sourceColumns.map((_, j) => {
        const v = r[j];
        return h('td', { class: v === null || v === undefined ? 'null' : '' }, v === null || v === undefined ? 'NULL' : String(v).slice(0, 120));
      })))),
    ),
    h('div.muted.preview-note', null, `Preview of the first ${rows.length} row${rows.length === 1 ? '' : 's'}`),
  );
}

function targetCard(): HTMLElement {
  const p = s.preview;
  const t = s.target;
  if (!p || !t) return card(2, 'Target table', [], true);
  const seg = h(
    'div.segmented',
    null,
    h('button', { class: s.createTable ? '' : 'on', onclick: () => { s.createTable = false; render(); } }, icon('table'), ' Existing table'),
    h('button', { class: s.createTable ? 'on' : '', onclick: () => { s.createTable = true; initNewColsIfEmpty(); render(); } }, icon('add'), ' New table'),
  );
  const body: (HTMLElement | null)[] = [h('div.target-row', null, seg, h('span.muted', null, `in database `, h('b', null, t.database)))];
  if (!s.createTable) {
    const sel = select([{ value: '', label: t.tables.length ? 'Select a table…' : 'No tables — create a new one' }, ...t.tables.map((x) => ({ value: x, label: x }))], s.table, (v) => {
      s.table = v;
      s.tableColumns = [];
      if (v) send({ type: 'loadTable', table: v });
      render();
    }, { class: 'table-select' });
    body.push(h('label.opt', null, 'Table', sel));
    if (s.table && s.tableColumns.length) {
      const src = p.sourceColumns;
      body.push(
        h('table.mapping', null,
          h('thead', null, h('tr', null, h('th', null, 'Table column'), h('th', null, 'Type'), h('th', null, ''), h('th', null, 'Source column'), h('th', null, 'Sample'))),
          h('tbody', null, s.tableColumns.map((c) => {
            const idx = s.mapping[c.name] ?? -1;
            const sample = idx >= 0 ? p.rows.slice(0, 3).map((r) => r[idx]).filter((v) => v !== null && v !== '').map(String).join(', ') : '';
            return h('tr', { class: idx < 0 ? 'skipped' : '' },
              h('td', null, c.pk ? icon('key', 'pk') : null, c.name),
              h('td.muted.mono', null, c.type),
              h('td.arrow', null, icon('arrow-left')),
              h('td', null, select([{ value: '-1', label: c.autoIncrement ? '— auto —' : c.defaultValue != null ? '— default —' : '— skip —' }, ...src.map((x, i) => ({ value: String(i), label: x }))], String(idx), (v) => { s.mapping[c.name] = Number(v); render(); })),
              h('td.muted.sample', { title: sample }, sample.slice(0, 60)),
            );
          })),
        ),
      );
    }
  } else {
    const nameInput = h('input', { type: 'text', value: s.newTable, spellcheck: false, placeholder: 'table_name' });
    nameInput.addEventListener('input', () => (s.newTable = nameInput.value));
    body.push(h('label.opt', null, 'New table name', nameInput));
    body.push(
      h('table.mapping', null,
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Source column'), h('th', null, 'Column name'), h('th', null, 'Type'))),
        h('tbody', null, s.newCols.map((c, i) => {
          const cb = h('input', { type: 'checkbox', checked: c.include });
          cb.addEventListener('change', () => { c.include = cb.checked; render(); });
          const name = h('input', { type: 'text', value: c.name, spellcheck: false, disabled: !c.include });
          name.addEventListener('input', () => (c.name = name.value));
          const type = h('input.mono', { type: 'text', value: c.type, spellcheck: false, disabled: !c.include, list: 'sqltypes' });
          type.addEventListener('input', () => (c.type = type.value));
          return h('tr', { class: c.include ? '' : 'skipped' }, h('td', null, cb), h('td', null, p.sourceColumns[i]), h('td', null, name), h('td', null, type));
        })),
      ),
      h('datalist#sqltypes', null, ['INT', 'BIGINT', 'DECIMAL(12,2)', 'DOUBLE', 'VARCHAR(255)', 'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TINYINT(1)', 'JSON'].map((x) => h('option', { value: x }))),
    );
  }
  return card(2, 'Target table', body);
}

function initNewColsIfEmpty(): void {
  if (!s.newCols.length) initNewCols();
}

function optionsCard(): HTMLElement {
  const ready = !!s.preview && (s.createTable ? !!s.newTable.trim() : !!s.table);
  if (!s.preview) return card(3, 'Options', [], true);
  const mode = select(
    [
      { value: 'insert', label: 'INSERT — stop on duplicate keys' },
      { value: 'ignore', label: 'INSERT IGNORE — skip rows with duplicate keys' },
      { value: 'replace', label: 'REPLACE — overwrite rows with duplicate keys' },
    ],
    s.mode,
    (v) => (s.mode = v as ImportPlan['mode']),
  );
  const trunc = h('input', { type: 'checkbox', checked: s.truncateFirst, disabled: s.createTable });
  trunc.addEventListener('change', () => (s.truncateFirst = trunc.checked));
  const empty = h('input', { type: 'checkbox', checked: s.emptyAsNull });
  empty.addEventListener('change', () => (s.emptyAsNull = empty.checked));
  const batch = h('input', { type: 'number', value: String(s.batchSize), min: 1, max: 5000 });
  batch.addEventListener('input', () => (s.batchSize = Number(batch.value)));

  const runBtn = h('button.btn.big', { disabled: !ready || s.running, onclick: run }, s.running ? icon('loading', 'spin') : icon('cloud-download'), s.running ? 'Importing…' : 'Import');
  const cancelBtn = s.running ? h('button.btn.secondary', { onclick: () => send({ type: 'cancel' }) }, 'Cancel') : null;

  const body: (HTMLElement | null)[] = [
    h('div.opts', null,
      h('label.opt', null, 'Mode', mode),
      h('label.opt', null, 'Rows per INSERT', batch),
    ),
    h('label.opt.check', null, empty, 'Treat empty values as NULL'),
    h('label.opt.check', { class: s.createTable ? 'muted' : '' }, trunc, 'Delete all existing rows first'),
    h('p.muted.note', null, icon('shield'), ' Runs in a single transaction: if any row fails, nothing is saved.'),
    h('div.run-row', null, runBtn, cancelBtn, s.progress && s.running ? h('span.progress', null, s.progress) : null),
  ];
  if (s.result) {
    body.push(
      h('div', { class: `result ${s.result.ok ? 'ok' : 'err'}` },
        icon(s.result.ok ? 'pass-filled' : 'error'),
        h('span', null, s.result.message),
        h('span.spacer'),
        s.result.ok ? h('button.btn.secondary', { onclick: () => send({ type: 'openTable', table: s.createTable ? s.newTable.trim() : s.table }) }, icon('table'), 'Open Table') : null,
        s.result.ok ? h('button.btn.secondary', { onclick: () => send({ type: 'close' }) }, 'Close') : null,
      ),
    );
  }
  return card(3, 'Options', body);
}

function run(): void {
  const plan: ImportPlan = {
    createTable: s.createTable,
    table: s.createTable ? s.newTable.trim() : s.table,
    newColumns: s.newCols.map((c, i) => ({ ...c, source: i })).filter((c) => c.include).map((c) => ({ name: c.name.trim(), type: c.type.trim(), source: c.source })),
    mapping: s.tableColumns.map((c) => ({ column: c.name, source: s.mapping[c.name] ?? -1 })),
    mode: s.mode,
    truncateFirst: !s.createTable && s.truncateFirst,
    emptyAsNull: s.emptyAsNull,
    batchSize: s.batchSize,
  };
  s.running = true;
  s.result = null;
  s.progress = 'Starting…';
  render();
  send({ type: 'run', plan });
}

function render(): void {
  const scrollTop = document.querySelector('.importer')?.scrollTop ?? 0;
  app.replaceChildren(
    h('div.importer', null,
      h('header.head', null, h('div.logo', null, icon('cloud-download')), h('div', null, h('h1', null, 'Import Data'), h('p.muted', null, s.target ? `Into database ${s.target.database}` : ''))),
      sourceCard(),
      targetCard(),
      optionsCard(),
    ),
  );
  document.querySelector('.importer')!.scrollTop = scrollTop;
}

window.addEventListener('message', (ev: MessageEvent<ImportToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      s.target = m.target;
      if (m.preselectTable) {
        s.table = m.preselectTable;
        send({ type: 'loadTable', table: m.preselectTable });
      } else if (!m.target.tables.length) {
        s.createTable = true;
      }
      render();
      break;
    case 'preview':
      s.preview = m.preview;
      s.previewError = '';
      s.result = null;
      s.newCols = [];
      initNewCols();
      autoMap();
      render();
      break;
    case 'previewError':
      s.previewError = m.message;
      render();
      break;
    case 'tableColumns':
      if (m.table === s.table) {
        s.tableColumns = m.columns;
        autoMap();
        render();
      }
      break;
    case 'progress':
      s.progress = m.message;
      {
        const el = document.querySelector('.progress');
        if (el) el.textContent = m.message;
        else render();
      }
      break;
    case 'finished':
      s.running = false;
      s.progress = '';
      s.result = { ok: m.ok, message: m.message };
      if (m.ok && s.createTable && s.target && !s.target.tables.includes(s.newTable.trim())) {
        s.target.tables.push(s.newTable.trim());
      }
      render();
      break;
  }
});

render();
send({ type: 'ready' });
