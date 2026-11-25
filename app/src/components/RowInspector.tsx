import { useEffect, useRef } from 'react';
import { Copy, KeyRound, MousePointerClick, Sparkles, Trash2 } from 'lucide-react';
import type { Cell, Column } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Switch, Tooltip } from '@/components/ui/misc';

interface Props {
  columns: Column[];
  values: Cell[] | undefined;
  rowLabel?: string;
  readOnly: boolean;
  deleted?: boolean;
  isModified: (col: number) => boolean;
  onChange: (col: number, value: Cell) => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
}

const isBool = (c: Column) => /^(tinyint\(1\)|bool|boolean)$/i.test(c.type);
const isLong = (c: Column) => /text|json|blob/i.test(c.type);

function AutoTextarea(props: React.ComponentProps<typeof Textarea>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(220, el.scrollHeight + 2)}px`;
    }
  }, [props.value]);
  return <Textarea ref={ref} {...props} />;
}

/** Form view of the selected row: the fastest way to read and edit one record. */
export function RowInspector({ columns, values, rowLabel, readOnly, deleted, isModified, onChange, onDelete, onDuplicate }: Props) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l bg-sidebar">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-[13px] font-semibold">{rowLabel ?? 'Row'}</span>
        {deleted && <span className="rounded bg-destructive/15 px-1.5 text-[11px] font-medium text-destructive">marked for deletion</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {onDuplicate && (
            <Tooltip content="Duplicate row">
              <Button size="icon-xs" variant="ghost" onClick={onDuplicate}>
                <Copy />
              </Button>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip content={deleted ? 'Restore row' : 'Delete row'}>
              <Button size="icon-xs" variant="ghost" className="hover:text-destructive" onClick={onDelete}>
                <Trash2 />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      {!values ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-muted-foreground">
          <MousePointerClick className="size-8 opacity-50" />
          <p className="text-[13px]">Select a row to see and edit all of its fields here.</p>
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {columns.map((c, i) => {
            const v = values[i];
            const modified = isModified(i);
            const disabled = readOnly || (c.autoIncrement && v === null);
            return (
              <div key={c.name} className={cn('rounded-lg border-l-2 border-transparent pl-2.5', modified && 'border-warning')}>
                <div className="mb-1 flex items-center gap-1.5">
                  {c.pk && <KeyRound className="size-3 text-amber-500" />}
                  <label className="truncate text-xs font-medium" htmlFor={`f-${c.name}`}>
                    {c.name}
                  </label>
                  {c.autoIncrement && (
                    <Tooltip content="Auto increment">
                      <Sparkles className="size-3 text-muted-foreground" />
                    </Tooltip>
                  )}
                  <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground">{c.type}</span>
                  {c.nullable !== false && !readOnly && (
                    <button
                      type="button"
                      className={cn(
                        'rounded px-1 font-mono text-[10px] font-semibold transition-colors',
                        v === null ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent',
                      )}
                      title={v === null ? 'Value is NULL' : 'Set to NULL'}
                      onClick={() => onChange(i, v === null ? '' : null)}
                    >
                      NULL
                    </button>
                  )}
                </div>
                {isBool(c) ? (
                  <div className="flex h-8 items-center gap-2">
                    <Switch id={`f-${c.name}`} checked={Number(v) === 1} disabled={disabled} onCheckedChange={(on) => onChange(i, on ? 1 : 0)} />
                    <span className="text-xs text-muted-foreground">{v === null ? 'NULL' : Number(v) === 1 ? 'true' : 'false'}</span>
                  </div>
                ) : c.options ? (
                  <select
                    id={`f-${c.name}`}
                    disabled={disabled}
                    value={v === null ? '' : String(v)}
                    onChange={(e) => onChange(i, e.target.value)}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60 dark:bg-input/30"
                  >
                    {v === null && <option value="">NULL</option>}
                    {c.options.map((o) => (
                      <option key={o} value={o} className="bg-popover">
                        {o}
                      </option>
                    ))}
                  </select>
                ) : isLong(c) ? (
                  <AutoTextarea
                    id={`f-${c.name}`}
                    disabled={disabled}
                    value={v === null ? '' : String(v)}
                    placeholder={v === null ? 'NULL' : ''}
                    onChange={(e) => onChange(i, e.target.value)}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                ) : (
                  <Input
                    id={`f-${c.name}`}
                    disabled={disabled}
                    value={v === null ? '' : String(v)}
                    placeholder={v === null ? (c.autoIncrement ? 'auto' : c.defaultValue != null ? `default: ${c.defaultValue}` : 'NULL') : ''}
                    onChange={(e) => onChange(i, e.target.value)}
                    inputMode={c.numeric ? 'decimal' : undefined}
                    className={cn(c.numeric && 'text-right font-mono tabular-nums', /date|time/i.test(c.type) && 'font-mono')}
                    spellCheck={false}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
