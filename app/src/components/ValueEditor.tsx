import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { AlertCircle, Braces, CheckCircle2, Download, FileUp, ImageIcon, Loader2, Minimize2 } from 'lucide-react';
import { backend } from '@/lib/backend';
import type { Cell, CellRef, Column } from '@/lib/types';
import { binaryLength, formatBytes, isBinaryColumn, isJsonColumn, isTruncatedBinary, sniff } from '@/lib/relations';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { editorLook } from '@/components/SqlEditor';

export interface ValueEditorRequest {
  column: Column;
  value: Cell;
  /** Shown under the title, e.g. "customers · row 12". */
  context: string;
  readOnly: boolean;
  /** Where the value is stored, so a large binary value can be loaded or saved to a file. */
  cell?: CellRef;
  onApply?: (value: Cell) => void;
}

const useValueEditor = create<{ req: ValueEditorRequest | null }>(() => ({ req: null }));

/** Opens the value editor: JSON with formatting and validation, binary as image / hex / text. */
export function openValueEditor(req: ValueEditorRequest) {
  useValueEditor.setState({ req });
}

/** Hex dump is capped so a multi-megabyte BLOB does not freeze the dialog. */
const HEX_DUMP_BYTES = 64 * 1024;

function hexToBytes(hex: string): Uint8Array {
  const body = hex.replace(/^0x/i, '');
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.substr(i * 2, 2), 16);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function bytesToHex(bytes: Uint8Array, limit = bytes.length): string {
  let s = '';
  for (let i = 0; i < Math.min(limit, bytes.length); i++) s += bytes[i].toString(16).padStart(2, '0').toUpperCase();
  return s;
}

/** Classic hex dump: offset, 16 bytes, printable ASCII. */
function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, HEX_DUMP_BYTES);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

/** The bytes as UTF-8 text, or null if they are not valid UTF-8 (or contain control bytes). */
function utf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\x00-\x08\x0e-\x1f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

type JsonCheck = { ok: true } | { ok: false; error: string };

function checkJson(text: string): JsonCheck {
  try {
    JSON.parse(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const looksLikeJson = (s: string) => /^\s*[[{]/.test(s) && checkJson(s).ok;

const wrapLook = [...editorLook, EditorView.lineWrapping];

export function ValueEditor() {
  const req = useValueEditor((s) => s.req);
  const close = () => useValueEditor.setState({ req: null });
  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && close()}>
      <DialogContent aria-describedby={undefined} className="flex h-[min(720px,85vh)] max-w-4xl flex-col gap-0 p-0">{req && <Body key={`${req.context}|${req.column.name}`} req={req} close={close} />}</DialogContent>
    </Dialog>
  );
}

function Body({ req, close }: { req: ValueEditorRequest; close: () => void }) {
  const { column, readOnly } = req;
  const binary = isBinaryColumn(column) && (req.value === null || binaryLength(req.value) !== null);
  return (
    <>
      <div className="flex items-center gap-2 border-b px-4 py-3 pr-12">
        <DialogTitle className="truncate text-[15px]">{column.name}</DialogTitle>
        <Badge variant="outline" className="font-mono">
          {column.type}
        </Badge>
        {readOnly && <Badge variant="secondary">read-only</Badge>}
        <span className="ml-auto truncate text-xs text-muted-foreground">{req.context}</span>
      </div>
      {binary ? <BinaryBody req={req} close={close} /> : <TextBody req={req} close={close} />}
    </>
  );
}

/* ----------------------------- text and JSON ----------------------------- */

function TextBody({ req, close }: { req: ValueEditorRequest; close: () => void }) {
  const { column, readOnly } = req;
  const initial = req.value === null ? '' : String(req.value);
  const jsonColumn = isJsonColumn(column);
  // A JSON column, or a text value that is a JSON document, gets the JSON tools.
  const [asJson] = useState(() => jsonColumn || looksLikeJson(initial));
  // JSON is shown pretty-printed; applying it unchanged keeps the stored text as it was.
  const [shownFirst] = useState(() => (asJson && initial ? pretty(initial) : initial));
  const [text, setText] = useState(shownFirst);
  const [isNull, setIsNull] = useState(req.value === null);
  const check = useMemo(() => (asJson && text.trim() ? checkJson(text) : null), [asJson, text]);
  const blocked = jsonColumn && !isNull && check !== null && !check.ok;
  const extensions = useMemo(() => (asJson ? [json(), ...wrapLook] : wrapLook), [asJson]);

  const apply = () => {
    if (blocked) return;
    const v: Cell = isNull ? null : text === shownFirst && req.value !== null ? initial : text;
    req.onApply?.(v);
    close();
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5">
        {asJson && (
          <>
            <Button size="sm" variant="ghost" disabled={!check?.ok || isNull} onClick={() => setText(pretty(text))}>
              <Braces /> Format
            </Button>
            <Button size="sm" variant="ghost" disabled={!check?.ok || isNull} onClick={() => setText(JSON.stringify(JSON.parse(text)))}>
              <Minimize2 /> Minify
            </Button>
          </>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          {isNull ? (
            <span className="text-muted-foreground">NULL</span>
          ) : check ? (
            check.ok ? (
              <span className="flex items-center gap-1 text-success">
                <CheckCircle2 className="size-3.5" /> Valid JSON
              </span>
            ) : (
              <span className="flex items-center gap-1 text-destructive">
                <AlertCircle className="size-3.5" /> {check.error}
              </span>
            )
          ) : (
            <span className="text-muted-foreground tabular-nums">{text.length.toLocaleString()} characters</span>
          )}
        </span>
      </div>
      <div className={cn('min-h-0 flex-1 overflow-auto', isNull && 'opacity-50')}>
        <CodeMirror
          value={text}
          onChange={(v) => {
            setText(v);
            setIsNull(false);
          }}
          extensions={extensions}
          theme="none"
          readOnly={readOnly}
          editable={!readOnly}
          height="100%"
          className="h-full font-mono text-[12.5px]"
          basicSetup={{ lineNumbers: true, foldGutter: asJson, highlightActiveLine: !readOnly, bracketMatching: true, closeBrackets: !readOnly, autocompletion: false, searchKeymap: true }}
        />
      </div>
      <Footer req={req} close={close} isNull={isNull} setNull={() => setIsNull(true)} onApply={apply} applyDisabled={blocked} />
    </>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/* ----------------------------- binary ----------------------------- */

type View = 'image' | 'hex' | 'text';

function BinaryBody({ req, close }: { req: ValueEditorRequest; close: () => void }) {
  const [value, setValue] = useState<Cell>(req.value);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const truncated = isTruncatedBinary(value);
  const changed = value !== req.value;

  // Small values arrive as hex; large ones are read again from the table.
  useEffect(() => {
    setError('');
    if (value === null) return setBytes(null);
    if (typeof value === 'string' && !isTruncatedBinary(value)) return setBytes(hexToBytes(value));
    if (!req.cell) {
      setBytes(null);
      return setError('This value is too large to show here. Open the table and open the value from there.');
    }
    let live = true;
    setLoading(true);
    backend
      .cellBytes(req.cell)
      .then((b64) => live && setBytes(base64ToBytes(b64)))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [value, req.cell]);

  const kind = useMemo(() => (bytes ? sniff(bytesToHex(bytes, 16)) : null), [bytes]);
  const text = useMemo(() => (bytes ? utf8(bytes) : null), [bytes]);
  const views: View[] = [...(kind?.mime.startsWith('image/') ? (['image'] as const) : []), 'hex', ...(text !== null && bytes?.length ? (['text'] as const) : [])];
  const [view, setView] = useState<View>();
  const shown = view && views.includes(view) ? view : views[0];
  const imageUrl = useMemo(() => (bytes && kind?.mime.startsWith('image/') ? `data:${kind.mime};base64,${bytesToBase64(bytes)}` : null), [bytes, kind]);

  const saveToFile = async () => {
    if (!req.cell) return;
    try {
      const ext = kind ? `.${kind.label.toLowerCase().replace('jpeg', 'jpg')}` : '.bin';
      const r = await backend.saveCell(req.cell, `${req.cell.table}_${req.column.name}${ext}`);
      if (r) toast.success(`Saved ${formatBytes(r.bytes)}`, { action: { label: 'Show', onClick: () => void backend.revealFile(r.path) } });
    } catch (e) {
      toast.error('Could not save the file', { description: (e as Error).message });
    }
  };

  const loadFromFile = async () => {
    try {
      const hex = await backend.loadFileHex();
      if (hex !== null) setValue(hex);
    } catch (e) {
      toast.error('Could not read the file', { description: (e as Error).message });
    }
  };

  const len = bytes?.length ?? binaryLength(value) ?? 0;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5">
        <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {views.map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn('flex h-6 items-center gap-1 rounded px-2 text-xs font-medium', shown === v ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground')}
            >
              {v === 'image' && <ImageIcon className="size-3.5" />}
              {v === 'image' ? 'Image' : v === 'hex' ? 'Hex' : 'Text'}
            </button>
          ))}
        </div>
        {req.cell && !changed && (
          <Button size="sm" variant="ghost" onClick={() => void saveToFile()}>
            <Download /> Save to file…
          </Button>
        )}
        {!req.readOnly && (
          <Button size="sm" variant="ghost" onClick={() => void loadFromFile()}>
            <FileUp /> Load from file…
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {kind ? `${kind.label} · ` : ''}
          {formatBytes(len)}
          {changed && ' · replaced, not applied yet'}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-10 text-center text-[13px] text-muted-foreground">
            <AlertCircle className="size-6 opacity-60" />
            {error}
          </div>
        ) : value === null ? (
          <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">NULL</div>
        ) : !bytes ? null : shown === 'image' && imageUrl ? (
          <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-6">
            <img src={imageUrl} alt={req.column.name} className="max-h-full max-w-full rounded shadow-lg [image-rendering:auto]" />
          </div>
        ) : shown === 'text' && text !== null ? (
          <pre className="p-4 font-mono text-[12.5px] whitespace-pre-wrap">{text}</pre>
        ) : (
          <>
            <pre className="p-4 font-mono text-[12px] leading-relaxed whitespace-pre text-muted-foreground">{hexDump(bytes)}</pre>
            {bytes.length > HEX_DUMP_BYTES && <p className="px-4 pb-4 text-xs text-muted-foreground">Showing the first {formatBytes(HEX_DUMP_BYTES)} of {formatBytes(bytes.length)}.</p>}
          </>
        )}
      </div>
      <Footer req={req} close={close} isNull={value === null} setNull={() => setValue(null)} onApply={() => (req.onApply?.(value), close())} applyDisabled={!changed || truncated} />
    </>
  );
}

/* ----------------------------- footer ----------------------------- */

function Footer({ req, close, isNull, setNull, onApply, applyDisabled }: { req: ValueEditorRequest; close: () => void; isNull: boolean; setNull: () => void; onApply: () => void; applyDisabled?: boolean }) {
  const copy = () => {
    void navigator.clipboard.writeText(req.value === null ? 'NULL' : String(req.value)).then(() => toast.success('Value copied'));
  };
  return (
    <DialogFooter className="border-t px-4 py-3">
      <Button variant="ghost" className="mr-auto" onClick={copy}>
        Copy original
      </Button>
      {!req.readOnly && req.column.nullable !== false && !isNull && (
        <Button variant="ghost" onClick={setNull}>
          Set NULL
        </Button>
      )}
      <Button variant="outline" onClick={close}>
        {req.readOnly ? 'Close' : 'Cancel'}
      </Button>
      {!req.readOnly && (
        <Button onClick={onApply} disabled={applyDisabled}>
          Apply
        </Button>
      )}
    </DialogFooter>
  );
}
