import type { SchemaInfo } from '../../src/shared/protocol';
import { h, icon } from '../common/dom';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'AS', 'DISTINCT',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'ON', 'USING', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT',
  'OFFSET', 'ASC', 'DESC', 'UNION', 'ALL', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'REPLACE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'TABLE', 'INDEX', 'VIEW', 'DATABASE', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'UNIQUE', 'DEFAULT', 'AUTO_INCREMENT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'RECURSIVE',
  'EXPLAIN', 'SHOW', 'DESCRIBE', 'USE', 'TRUE', 'FALSE', 'REGEXP', 'INTERVAL', 'DUPLICATE', 'IGNORE', 'COLUMN',
  'ADD', 'MODIFY', 'RENAME', 'TO', 'IF', 'TABLES', 'COLUMNS', 'PROCESSLIST', 'START', 'TRANSACTION', 'COMMIT', 'ROLLBACK',
];
const KEYWORD_SET = new Set(KEYWORDS);

const FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'CONCAT', 'CONCAT_WS', 'COALESCE', 'IFNULL', 'NULLIF', 'IF',
  'NOW', 'CURDATE', 'CURTIME', 'DATE', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'TIMESTAMPDIFF',
  'UNIX_TIMESTAMP', 'FROM_UNIXTIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'LOWER', 'UPPER', 'TRIM', 'SUBSTRING',
  'LEFT', 'RIGHT', 'LENGTH', 'CHAR_LENGTH', 'ROUND', 'FLOOR', 'CEIL', 'ABS', 'CAST', 'CONVERT', 'JSON_EXTRACT',
  'JSON_UNQUOTE', 'JSON_OBJECT', 'JSON_ARRAY', 'JSON_CONTAINS', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD',
  'UUID', 'MD5', 'SHA2', 'FIND_IN_SET', 'REPLACE', 'LPAD', 'RPAD', 'FORMAT', 'GREATEST', 'LEAST',
];
const FUNCTION_SET = new Set(FUNCTIONS);

/** Keywords after which a table name is expected. */
const TABLE_CONTEXT = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'DESCRIBE', 'DESC', 'TRUNCATE']);

type Kind = 'column' | 'table' | 'keyword' | 'function';

interface Item {
  label: string;
  insert: string;
  kind: Kind;
  detail: string;
  pk?: boolean;
  score: number;
}

const TOKEN_RE =
  /(--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|\\[\s\S]|'')*'?|"(?:[^"\\]|\\[\s\S])*"?)|(`[^`]*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/g;

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function needsQuote(name: string): boolean {
  return !/^[A-Za-z_][\w$]*$/.test(name) || KEYWORD_SET.has(name.toUpperCase());
}

export interface SqlEditorOptions {
  onRun: (sql: string) => void;
  placeholder?: string;
}

/**
 * Small SQL editor: a transparent textarea over a highlighted <pre>, with
 * schema-aware autocomplete. Ctrl+Enter runs, Ctrl+Space opens suggestions.
 */
export class SqlEditor {
  readonly el: HTMLElement;
  private readonly ta: HTMLTextAreaElement;
  private readonly hl: HTMLElement;
  private readonly popup: HTMLElement;
  private schema: SchemaInfo | null = null;
  private items: Item[] = [];
  private active = 0;
  private wordStart = 0;
  private lineH = 20;
  private charW = 7.8;

  constructor(private readonly opts: SqlEditorOptions) {
    this.hl = h('pre.sql-hl', { 'aria-hidden': 'true' });
    this.ta = h('textarea.sql-input', { spellcheck: false, wrap: 'off', placeholder: opts.placeholder ?? '', autocapitalize: 'off', autocomplete: 'off' });
    this.ta.setAttribute('autocorrect', 'off');
    this.popup = h('div.sql-suggest', { role: 'listbox' });
    this.popup.hidden = true;
    this.el = h('div.sql-editor', null, this.hl, this.ta);
    document.body.append(this.popup);

    this.ta.addEventListener('input', () => {
      this.refresh();
      this.suggest(false);
    });
    this.ta.addEventListener('scroll', () => {
      this.hl.scrollTop = this.ta.scrollTop;
      this.hl.scrollLeft = this.ta.scrollLeft;
      this.placePopup();
    });
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('blur', () => setTimeout(() => this.hide(), 120));
    this.ta.addEventListener('click', () => this.hide());
    this.popup.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>('.sg-item');
      if (row) {
        this.active = Number(row.dataset.i);
        this.accept();
      }
    });
    requestAnimationFrame(() => this.measure());
    this.refresh();
  }

  get value(): string {
    return this.ta.value;
  }

  set value(v: string) {
    if (v !== this.ta.value) {
      this.ta.value = v;
      this.refresh();
    }
  }

  get focused(): boolean {
    return document.activeElement === this.ta;
  }

  focus(): void {
    this.ta.focus();
  }

  setSchema(s: SchemaInfo): void {
    this.schema = s;
    this.refresh();
  }

  private measure(): void {
    const cs = getComputedStyle(this.ta);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    this.charW = ctx.measureText('M'.repeat(50)).width / 50;
    this.lineH = parseFloat(cs.lineHeight) || 20;
    this.refresh();
  }

  /* ----------------------------- highlighting ----------------------------- */

  private refresh(): void {
    const text = this.ta.value;
    const tables = new Set((this.schema?.tables ?? []).map((t) => t.toLowerCase()));
    let out = '';
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(text))) {
      const [tok, comment, str, quoted, num, word] = m;
      if (comment) out += `<span class="t-com">${esc(tok)}</span>`;
      else if (str) out += `<span class="t-str">${esc(tok)}</span>`;
      else if (quoted) out += `<span class="t-id">${esc(tok)}</span>`;
      else if (num) out += `<span class="t-num">${tok}</span>`;
      else if (word) {
        const up = word.toUpperCase();
        const next = text.slice(TOKEN_RE.lastIndex).match(/^\s*\(/);
        if (FUNCTION_SET.has(up) && next) out += `<span class="t-fn">${esc(tok)}</span>`;
        else if (KEYWORD_SET.has(up)) out += `<span class="t-kw">${esc(tok)}</span>`;
        else if (tables.has(word.toLowerCase())) out += `<span class="t-tbl">${esc(tok)}</span>`;
        else out += esc(tok);
      } else if (/[=<>!+\-*/%]/.test(tok)) out += `<span class="t-op">${esc(tok)}</span>`;
      else out += esc(tok);
    }
    // Trailing newline keeps the last empty line the same height as the textarea.
    this.hl.innerHTML = out + '\n';
    const total = text.split('\n').length;
    const lines = Math.min(10, Math.max(1, total));
    const pad = 12;
    this.el.style.height = `${lines * this.lineH + pad}px`;
    // Only scroll vertically once the editor stops growing.
    this.ta.style.overflowY = total > 10 ? 'auto' : 'hidden';
  }

  /* ----------------------------- autocomplete ----------------------------- */

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      this.opts.onRun(this.ta.value);
      return;
    }
    if (mod && (e.key === ' ' || e.code === 'Space')) {
      e.preventDefault();
      this.suggest(true);
      return;
    }
    if (!this.popup.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.items.length;
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        this.renderPopup();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.accept();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        return;
      }
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        this.active = Math.max(0, Math.min(this.items.length - 1, this.active + (e.key === 'PageDown' ? 8 : -8)));
        this.renderPopup();
        return;
      }
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      this.insert('  ');
    }
  }

  private referencedTables(text: string): Map<string, string> {
    // alias/name (lowercase) -> table name
    const out = new Map<string, string>();
    const re = /\b(?:from|join|update|into)\s+(?:`?[\w$]+`?\s*\.\s*)?`?([\w$]+)`?(?:\s+(?:as\s+)?`?([\w$]+)`?)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const table = this.findTable(m[1]);
      if (!table) continue;
      out.set(table.toLowerCase(), table);
      const alias = m[2];
      if (alias && !KEYWORD_SET.has(alias.toUpperCase())) out.set(alias.toLowerCase(), table);
    }
    return out;
  }

  private findTable(name: string): string | undefined {
    const lower = name.toLowerCase();
    return this.schema?.tables.find((t) => t.toLowerCase() === lower);
  }

  private inStringOrComment(before: string): boolean {
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((m = TOKEN_RE.exec(before))) last = m;
    if (!last) return false;
    const [tok, comment, str] = last;
    if (comment) return !(tok.startsWith('/*') && tok.endsWith('*/') && tok.length > 3);
    if (str) {
      const q = tok[0];
      return tok.length === 1 || !tok.endsWith(q) || /\\$/.test(tok.slice(0, -1));
    }
    return false;
  }

  private suggest(force: boolean): void {
    const pos = this.ta.selectionStart;
    if (pos !== this.ta.selectionEnd) return this.hide();
    const text = this.ta.value;
    const before = text.slice(0, pos);
    if (this.inStringOrComment(before)) return this.hide();

    const qual = /(`[^`]+`|[\w$]+)\.`?([\w$]*)$/.exec(before);
    const word = qual ? qual[2] : (/[\w$]*$/.exec(before)?.[0] ?? '');
    if (!qual && !force && word.length < 1) return this.hide();
    if (!qual && /\d/.test(word[0] ?? '')) return this.hide();
    this.wordStart = pos - word.length;

    const schema = this.schema;
    const refs = this.referencedTables(text);
    const lowerWord = word.toLowerCase();
    const candidates: Item[] = [];
    const push = (it: Omit<Item, 'score'>) => {
      const l = it.label.toLowerCase();
      let score: number;
      if (!lowerWord) score = 1;
      else if (l.startsWith(lowerWord)) score = 0;
      else if (lowerWord.length >= 2 && l.includes(lowerWord)) score = 2;
      else return;
      candidates.push({ ...it, score });
    };
    const colItems = (table: string) => {
      for (const c of schema?.columns[table] ?? []) {
        push({ label: c.name, insert: needsQuote(c.name) ? `\`${c.name}\`` : c.name, kind: 'column', detail: `${c.type}${refs.size > 1 || table !== schema?.table ? ' · ' + table : ''}`, pk: c.pk });
      }
    };

    if (qual) {
      const q = qual[1].replace(/`/g, '').toLowerCase();
      const table = refs.get(q) ?? this.findTable(q);
      if (table) colItems(table);
    } else {
      const prev = /([A-Za-z_]+)\s+[\w$]*$/.exec(before)?.[1]?.toUpperCase();
      const wantsTable = prev !== undefined && TABLE_CONTEXT.has(prev);
      if (wantsTable) {
        for (const t of schema?.tables ?? []) push({ label: t, insert: needsQuote(t) ? `\`${t}\`` : t, kind: 'table', detail: 'table' });
      } else {
        const seen = new Set<string>();
        const tablesInScope = refs.size ? [...new Set(refs.values())] : schema ? [schema.table] : [];
        for (const t of tablesInScope) {
          if (seen.has(t)) continue;
          seen.add(t);
          colItems(t);
        }
        for (const t of schema?.tables ?? []) push({ label: t, insert: needsQuote(t) ? `\`${t}\`` : t, kind: 'table', detail: 'table' });
        candidates.forEach((c) => c.kind === 'table' && (c.score += 4));
        for (const k of KEYWORDS) push({ label: k, insert: k, kind: 'keyword', detail: 'keyword' });
        for (const f of FUNCTIONS) push({ label: f, insert: `${f}()`, kind: 'function', detail: 'function' });
        candidates.forEach((c) => (c.kind === 'keyword' || c.kind === 'function') && (c.score += 5));
      }
    }

    const order: Record<Kind, number> = { column: 0, table: 1, keyword: 2, function: 3 };
    candidates.sort((a, b) => a.score - b.score || order[a.kind] - order[b.kind] || a.label.length - b.label.length || a.label.localeCompare(b.label));
    // De-duplicate labels (e.g. REPLACE keyword and function).
    const uniq: Item[] = [];
    const labels = new Set<string>();
    for (const c of candidates) {
      const key = c.kind + c.label.toLowerCase();
      if (labels.has(key)) continue;
      labels.add(key);
      uniq.push(c);
      if (uniq.length >= 60) break;
    }
    if (!uniq.length || (uniq.length === 1 && uniq[0].label.toLowerCase() === lowerWord && !force)) return this.hide();
    this.items = uniq;
    this.active = 0;
    this.popup.hidden = false;
    this.renderPopup();
    this.placePopup();
  }

  private renderPopup(): void {
    const word = this.ta.value.slice(this.wordStart, this.ta.selectionStart).toLowerCase();
    const iconFor: Record<Kind, string> = { column: 'symbol-field', table: 'table', keyword: 'symbol-keyword', function: 'symbol-method' };
    this.popup.replaceChildren(
      ...this.items.map((it, i) => {
        const l = it.label;
        const at = word ? l.toLowerCase().indexOf(word) : -1;
        const label =
          at >= 0
            ? [l.slice(0, at), h('b', null, l.slice(at, at + word.length)), l.slice(at + word.length)]
            : [l];
        return h(
          'div',
          { class: `sg-item ${i === this.active ? 'active' : ''} k-${it.kind}`, dataset: { i: String(i) }, role: 'option' },
          it.pk ? icon('key', 'sg-icon pk') : icon(iconFor[it.kind], 'sg-icon'),
          h('span.sg-label', null, ...label),
          h('span.sg-detail', null, it.detail),
        );
      }),
    );
    (this.popup.children[this.active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  private placePopup(): void {
    if (this.popup.hidden) return;
    const before = this.ta.value.slice(0, this.wordStart).split('\n');
    const line = before.length - 1;
    const col = before[before.length - 1].length;
    const r = this.ta.getBoundingClientRect();
    const cs = getComputedStyle(this.ta);
    const padL = parseFloat(cs.paddingLeft) || 8;
    const padT = parseFloat(cs.paddingTop) || 6;
    let x = r.left + padL + col * this.charW - this.ta.scrollLeft - 22;
    const y = r.top + padT + (line + 1) * this.lineH - this.ta.scrollTop + 2;
    const w = this.popup.offsetWidth || 360;
    x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
    this.popup.style.left = `${x}px`;
    this.popup.style.top = `${y}px`;
    this.popup.style.maxHeight = `${Math.max(120, Math.min(300, window.innerHeight - y - 8))}px`;
  }

  private accept(): void {
    const it = this.items[this.active];
    if (!it) return;
    const end = this.ta.selectionStart;
    // Also replace the rest of an identifier when completing in the middle of one.
    const rest = /^[\w$]*/.exec(this.ta.value.slice(end))?.[0].length ?? 0;
    this.ta.setSelectionRange(this.wordStart, end + rest);
    this.insert(it.kind === 'keyword' ? it.insert + ' ' : it.insert);
    if (it.kind === 'function') {
      const p = this.ta.selectionStart - 1;
      this.ta.setSelectionRange(p, p);
    }
    this.hide();
    this.refresh();
  }

  private insert(text: string): void {
    // execCommand keeps the browser's undo stack working.
    if (!document.execCommand('insertText', false, text)) {
      this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
      this.refresh();
    }
  }

  private hide(): void {
    this.popup.hidden = true;
    this.items = [];
  }
}
