import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface AskOptions {
  title: string;
  description?: string;
  confirm: string;
  danger?: boolean;
  /** Ask for text; `mustEqual` requires typing an exact value (e.g. a database name). */
  input?: { placeholder?: string; mustEqual?: string; initial?: string };
}

interface AskState {
  opts?: AskOptions;
  resolve?: (v: string | null) => void;
}

const useAsk = create<AskState>(() => ({}));

/** Resolves with the typed text (or '' without input) when confirmed, null when cancelled. */
export function ask(opts: AskOptions): Promise<string | null> {
  return new Promise((resolve) => useAsk.setState({ opts, resolve }));
}

export function AskDialog() {
  const { opts, resolve } = useAsk();
  const [value, setValue] = useState('');
  useEffect(() => setValue(opts?.input?.initial ?? ''), [opts]);
  const close = (v: string | null) => {
    resolve?.(v);
    useAsk.setState({ opts: undefined, resolve: undefined });
  };
  const ok = !opts?.input || (opts.input.mustEqual ? value === opts.input.mustEqual : value.trim().length > 0);
  return (
    <Dialog open={!!opts} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader className="flex-row items-start gap-3">
          {opts?.danger && (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              <AlertTriangle className="size-4.5" />
            </span>
          )}
          <div className="space-y-1">
            <DialogTitle>{opts?.title}</DialogTitle>
            {opts?.description && <DialogDescription className="text-[13px] leading-relaxed">{opts.description}</DialogDescription>}
          </div>
        </DialogHeader>
        {opts?.input && (
          <div className="px-5">
            <Input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ok && close(value.trim())}
              placeholder={opts.input.placeholder}
              className="font-mono"
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button variant={opts?.danger ? 'destructive' : 'default'} disabled={!ok} onClick={() => close(opts?.input ? value.trim() : '')} autoFocus={!opts?.input}>
            {opts?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
