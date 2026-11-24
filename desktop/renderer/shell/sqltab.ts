import type * as Monaco from 'monaco-editor';
import { h, icon } from '../../../webview-ui/common/dom';
import { splitSql, statementAt, Statement } from '../../../src/query/splitter';
import { invoke } from './api';

declare const monaco: typeof Monaco;

export interface Binding {
  connId: string;
  db?: string;
}

export interface SqlTabCallbacks {
  title(title: string): void;
  dirty(dirty: boolean): void;
  binding(): void;
}

/** A SQL editor (Monaco) with a results grid underneath. */
export class SqlTab {
  readonly el: HTMLElement;
  readonly resultsViewId: string;
  editor?: Monaco.editor.IStandaloneCodeEditor;
  model?: Monaco.editor.ITextModel;
  binding?: Binding;
  path?: string;
  private savedVersion = 0;
  private readonly bindingBtn: HTMLButtonElement;
  private readonly editorHost: HTMLElement;
  private readonly results: HTMLIFrameElement;
  private flash: string[] = [];

  constructor(
    readonly tabId: string,
    initial: { text: string; binding?: Binding; path?: string },
    private readonly cb: SqlTabCallbacks,
    private readonly connName: (id: string) => string | undefined,
  ) {
    this.binding = initial.binding;
    this.path = initial.path;
    this.resultsViewId = `results:${tabId}`;
    this.bindingBtn = h('button.binding-btn', { title: 'Connection and database for this tab', onclick: () => void this.pickBinding() });
    this.editorHost = h('div.sql-editor-host');
    this.results = h('iframe.view-frame', { src: `app://lens/views/grid.html?view=${encodeURIComponent(this.resultsViewId)}` });
    const splitter = h('div.hsplit', { title: 'Drag to resize' });
    const top = h('div.sql-top', null, this.editorHost);
    this.el = h(
      'div.sql-tab',
      null,
      h(
        'div.toolbar.sql-toolbar',
        null,
        this.bindingBtn,
        h('span.sep'),
        h('button.btn.small.run', { title: 'Run statement at cursor or selection (Ctrl+Enter)', onclick: () => void this.run('statement') }, icon('play'), 'Run'),
        h('button.btn.secondary.small', { title: 'Run all statements (Ctrl+Shift+Enter)', onclick: () => void this.run('all') }, icon('run-all'), 'Run All'),
        h('button.icon-btn', { title: 'Cancel running query', onclick: () => void invoke('sql.cancel', this.tabId) }, icon('debug-stop')),
        h('span.spacer'),
        h('button.icon-btn', { title: 'Save (Ctrl+S)', onclick: () => void this.save() }, icon('save')),
      ),
      top,
      splitter,
      h('div.sql-bottom', null, this.results),
    );
    this.initSplitter(splitter, top);
    this.renderBinding();
    void invoke('view.open', this.resultsViewId, { kind: 'results', tabId });
    this.createEditor(initial.text);
  }

  private createEditor(text: string): void {
    this.model = monaco.editor.createModel(text, 'sql');
    (this.model as unknown as { __tab: SqlTab }).__tab = this;
    this.editor = monaco.editor.create(this.editorHost, {
      model: this.model,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      tabSize: 2,
      wordWrap: 'off',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      fixedOverflowWidgets: true,
      padding: { top: 8 },
    });
    this.savedVersion = this.model.getAlternativeVersionId();
    this.model.onDidChangeContent(() => this.cb.dirty(this.isDirty));
    const KM = monaco.KeyMod;
    const KC = monaco.KeyCode;
    this.editor.addCommand(KM.CtrlCmd | KC.Enter, () => void this.run('statement'));
    this.editor.addCommand(KM.CtrlCmd | KM.Shift | KC.Enter, () => void this.run('all'));
    this.editor.addCommand(KM.CtrlCmd | KC.KeyS, () => void this.save());
    this.editor.focus();
  }

  get isDirty(): boolean {
    return !!this.model && this.model.getAlternativeVersionId() !== this.savedVersion && (this.path !== undefined || this.model.getValueLength() > 0);
  }

  get text(): string {
    return this.model?.getValue() ?? '';
  }

  focus(): void {
    this.editor?.focus();
  }

  setBinding(b: Binding): void {
    this.binding = b;
    this.renderBinding();
    this.cb.binding();
  }

  renderBinding(): void {
    const name = this.binding ? this.connName(this.binding.connId) : undefined;
    this.bindingBtn.replaceChildren(
      icon(name ? 'database' : 'plug'),
      h('span', null, name ? `${name}${this.binding?.db ? ' › ' + this.binding.db : ''}` : 'Select connection'),
      icon('chevron-down', 'muted'),
    );
  }

  async pickBinding(): Promise<boolean> {
    const b = await invoke('sql.pickBinding', this.tabId, undefined);
    if (!b) return false;
    this.setBinding(b);
    return true;
  }

  async run(mode: 'statement' | 'all'): Promise<void> {
    if (!this.editor || !this.model) return;
    if (!this.binding && !(await this.pickBinding())) return;
    const text = this.model.getValue();
    const sel = this.editor.getSelection();
    let stmts: Statement[];
    let base = 0;
    if (mode === 'all') {
      stmts = splitSql(text);
    } else if (sel && !sel.isEmpty()) {
      base = this.model.getOffsetAt(sel.getStartPosition());
      stmts = splitSql(this.model.getValueInRange(sel));
    } else {
      const pos = this.editor.getPosition();
      const st = statementAt(text, pos ? this.model.getOffsetAt(pos) : 0);
      stmts = st ? [st] : [];
    }
    if (!stmts.length) return;
    const ranges = stmts.map((s) => {
      const a = this.model!.getPositionAt(base + s.start);
      const b = this.model!.getPositionAt(base + s.end);
      return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { className: 'run-flash', isWholeLine: false } };
    });
    this.flash = this.editor.deltaDecorations(this.flash, ranges);
    setTimeout(() => (this.flash = this.editor?.deltaDecorations(this.flash, []) ?? []), 700);
    await invoke('sql.run', { tabId: this.tabId, connId: this.binding!.connId, db: this.binding!.db, statements: stmts.map((s) => s.sql) });
  }

  async save(): Promise<void> {
    if (!this.model) return;
    const p = await invoke('file.save', this.path, this.model.getValue());
    if (!p) return;
    this.path = p;
    this.savedVersion = this.model.getAlternativeVersionId();
    this.cb.title(p.split(/[\\/]/).pop() ?? p);
    this.cb.dirty(false);
  }

  private initSplitter(splitter: HTMLElement, top: HTMLElement): void {
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = top.getBoundingClientRect().height;
      const total = this.el.getBoundingClientRect().height;
      document.body.classList.add('row-resizing');
      // Iframes swallow mouse events while dragging; block them.
      this.results.style.pointerEvents = 'none';
      const move = (ev: MouseEvent) => {
        const hgt = Math.max(80, Math.min(total - 120, startH + ev.clientY - startY));
        top.style.flexBasis = `${hgt}px`;
      };
      const up = () => {
        document.body.classList.remove('row-resizing');
        this.results.style.pointerEvents = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  dispose(): void {
    void invoke('view.close', this.resultsViewId);
    void invoke('sql.close', this.tabId);
    this.editor?.dispose();
    this.model?.dispose();
  }
}
