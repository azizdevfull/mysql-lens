import { useMemo, useRef } from 'react';
import CodeMirror, { EditorView, keymap, Prec, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { MySQL, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { toast } from 'sonner';
import type { Column } from '@/lib/types';
import { splitSql, statementAt } from '@/lib/sqlsplit';
import { formatSql } from '@/lib/format';

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-content': { caretColor: 'var(--primary)', padding: '8px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'color-mix(in oklch, var(--muted-foreground) 70%, transparent)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 55%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklch, var(--primary) 28%, transparent) !important' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in oklch, var(--primary) 20%, transparent)', outline: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: '8px', boxShadow: '0 12px 32px rgb(0 0 0 / 0.25)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12.5px', maxHeight: '18em', padding: '4px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px !important', borderRadius: '5px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' },
  '.cm-completionDetail': { opacity: 0.65, fontStyle: 'normal', marginLeft: '12px' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 700 },
  '.cm-completionIcon': { width: '18px', padding: '0', marginRight: '6px', fontSize: '9.5px', fontWeight: 700, fontFamily: 'var(--font-sans)', textAlign: 'center', borderRadius: '4px', opacity: 1 },
  '.cm-completionIcon-property::after': { content: '"col"', color: 'oklch(0.7 0.14 230)' },
  '.cm-completionIcon-keyword::after': { content: '"kw"', color: 'var(--syntax-keyword)' },
  '.cm-completionIcon-type::after': { content: '"tbl"', color: 'oklch(0.75 0.14 75)' },
  '.cm-completionIcon-class::after': { content: '"tbl"', color: 'oklch(0.75 0.14 75)' },
  '.cm-completionIcon-function::after, .cm-completionIcon-method::after': { content: '"fn"', color: 'var(--syntax-function)' },
  '.cm-completionIcon-namespace::after': { content: '"db"', color: 'oklch(0.7 0.15 150)' },
  '.cm-completionIcon-variable::after': { content: '"var"' },
  '.cm-completionIcon-text::after': { content: '"abc"' },
  'li[aria-selected] .cm-completionIcon::after': { color: 'inherit' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
  '.cm-run-flash': { backgroundColor: 'color-mix(in oklch, var(--primary) 18%, transparent)' },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syntax-keyword)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syntax-number)' },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: 'var(--syntax-function)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [t.typeName], color: 'var(--syntax-function)' },
  { tag: [t.special(t.name)], color: 'var(--syntax-number)' },
  { tag: [t.propertyName], color: 'var(--syntax-function)' },
  { tag: [t.operator, t.punctuation], color: 'color-mix(in oklch, var(--foreground) 70%, transparent)' },
]);

/** The editor look (colors, tooltips, highlighting) for other CodeMirror editors in the app. */
export const editorLook = [syntaxHighlighting(highlight), theme];

/**
 * Formats the selection, or the whole text when nothing is selected (Shift+Alt+F).
 * Skipped if the text changed while the formatter was loading.
 */
function formatCommand(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const from = sel.empty ? 0 : sel.from;
  const to = sel.empty ? view.state.doc.length : sel.to;
  const before = view.state.doc.toString();
  const text = before.slice(from, to);
  if (!text.trim()) return true;
  formatSql(text).then(
    (pretty) => {
      if (view.state.doc.toString() !== before || pretty === text) return;
      view.dispatch({ changes: { from, to, insert: pretty }, selection: sel.empty ? undefined : { anchor: from, head: from + pretty.length }, userEvent: 'input.format' });
    },
    (e: Error) => toast.error('Could not format this SQL', { description: e.message }),
  );
  return true;
}

export interface SqlEditorProps {
  value: string;
  onChange?: (v: string) => void;
  /** Called with the statements to run (selection, statement at cursor, or all). */
  onRun?: (statements: string[], all: boolean) => void;
  schema?: Record<string, Column[]>;
  defaultTable?: string;
  placeholder?: string;
  minimal?: boolean;
  autoFocus?: boolean;
  /** Filled with a function that runs like Ctrl+Enter (all = Ctrl+Shift+Enter), for toolbar buttons. */
  runRef?: React.MutableRefObject<((all: boolean) => void) | null>;
  /** Filled with a function that formats like Shift+Alt+F, for toolbar buttons. */
  formatRef?: React.MutableRefObject<(() => void) | null>;
  className?: string;
}

export function SqlEditor({ value, onChange, onRun, schema, defaultTable, placeholder, minimal, autoFocus, runRef, formatRef, className }: SqlEditorProps) {
  const cm = useRef<ReactCodeMirrorRef>(null);
  const { extensions, run } = useMemo(() => {
    const cmSchema = schema ? Object.fromEntries(Object.entries(schema).map(([table, cols]) => [table, cols.map((c) => ({ label: c.name, type: 'property', detail: c.type, boost: c.pk ? 2 : 0 }))])) : undefined;
    const run = (all: boolean) => (view: EditorView) => {
      const text = view.state.doc.toString();
      const sel = view.state.selection.main;
      let stmts: { sql: string; start: number; end: number }[];
      let base = 0;
      if (all) stmts = splitSql(text);
      else if (!sel.empty) {
        base = sel.from;
        stmts = splitSql(text.slice(sel.from, sel.to));
      } else {
        const s = statementAt(text, sel.head);
        stmts = s ? [s] : [];
      }
      if (stmts.length && !all && sel.empty) {
        const s = stmts[0];
        view.dispatch({ selection: { anchor: base + s.start, head: base + s.end } });
        setTimeout(() => view.dispatch({ selection: { anchor: sel.head } }), 260);
      }
      onRun?.(stmts.map((s) => s.sql), all);
      return true;
    };
    const extensions = [
      sql({ dialect: MySQL, schema: cmSchema, defaultTable, upperCaseKeywords: true }),
      syntaxHighlighting(highlight),
      theme,
      Prec.highest(
        keymap.of([
          { key: 'Mod-Enter', run: run(false) },
          { key: 'Shift-Mod-Enter', run: run(true) },
          { key: 'Shift-Alt-f', run: formatCommand },
        ]),
      ),
      EditorView.lineWrapping,
    ];
    return { extensions, run };
  }, [schema, defaultTable, onRun]);

  if (runRef) {
    runRef.current = (all) => {
      const view = cm.current?.view;
      if (view) {
        view.focus();
        run(all)(view);
      }
    };
  }

  if (formatRef) {
    formatRef.current = () => {
      const view = cm.current?.view;
      if (view) {
        view.focus();
        formatCommand(view);
      }
    };
  }

  return (
    <CodeMirror
      ref={cm}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="none"
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={className}
      height="100%"
      basicSetup={{
        lineNumbers: !minimal,
        foldGutter: false,
        highlightActiveLine: !minimal,
        highlightActiveLineGutter: !minimal,
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
        searchKeymap: true,
        defaultKeymap: true,
        historyKeymap: true,
        indentOnInput: true,
        tabSize: 2,
      }}
    />
  );
}
