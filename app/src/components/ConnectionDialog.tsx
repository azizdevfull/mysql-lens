import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, ChevronDown, Eye, EyeOff, KeyRound, Link2, Loader2, Lock, Server, ShieldCheck, XCircle } from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp } from '@/lib/store';
import type { Connection } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, Switch } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { colorOf } from '@/views/QueryView';

const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const blank: Connection = { id: '', name: '', color: '', host: '127.0.0.1', port: 3306, user: 'root', database: '' };

function Field({ label, children, className, hint }: { label: string; children: React.ReactNode; className?: string; hint?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label>{label}</Label>
      {children}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Section({ icon, title, desc, on, onToggle, children }: { icon: React.ReactNode; title: string; desc: string; on: boolean; onToggle: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border transition-colors', on && 'bg-muted/30')}>
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
        <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
        <span className="flex-1">
          <span className="block text-[13px] font-medium">{title}</span>
          <span className="block text-[11px] text-muted-foreground">{desc}</span>
        </span>
        <Switch checked={on} onCheckedChange={onToggle} />
      </label>
      {on && <div className="grid grid-cols-6 gap-3 border-t px-3 py-3">{children}</div>}
    </div>
  );
}

export function ConnectionDialog() {
  const { open, editing } = useApp((s) => s.connDialog);
  const close = useApp((s) => s.closeConnDialog);
  const [c, setC] = useState<Connection>(blank);
  const [password, setPassword] = useState('');
  const [sshSecret, setSshSecret] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [url, setUrl] = useState('');
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ state: 'idle' });
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (open) {
      setC(editing ? { ...blank, ...editing } : blank);
      setPassword('');
      setSshSecret('');
      setUrl('');
      setTest({ state: 'idle' });
    }
  }, [open, editing]);

  const set = <K extends keyof Connection>(k: K, v: Connection[K]) => setC((x) => ({ ...x, [k]: v }));

  const applyUrl = (u: string) => {
    try {
      const p = new URL(u.trim());
      if (!/^(mysql|mariadb):$/.test(p.protocol)) return;
      setC((x) => ({ ...x, host: p.hostname || x.host, port: Number(p.port) || 3306, user: decodeURIComponent(p.username) || x.user, database: decodeURIComponent(p.pathname.slice(1)) || x.database, name: x.name || `${decodeURIComponent(p.username)}@${p.hostname}` }));
      if (p.password) setPassword(decodeURIComponent(p.password));
      toast.success('Filled from URL');
    } catch {
      // not a URL yet
    }
  };

  const runTest = async () => {
    setTest({ state: 'busy' });
    try {
      setTest({ state: 'ok', msg: `Connected · ${await backend.testConnection(c, password)}` });
    } catch (e) {
      setTest({ state: 'err', msg: (e as Error).message });
    }
  };

  const save = async (connect: boolean) => {
    const saved = await backend.saveConnection(
      { ...c, id: c.id || (backend.native ? '' : `c-${Date.now()}`), name: c.name.trim() || `${c.user}@${c.host}` },
      { password, sshPassword: c.ssh?.auth === 'password' ? sshSecret : undefined, sshPassphrase: c.ssh?.auth === 'key' ? sshSecret : undefined },
    );
    await useApp.getState().load();
    close();
    toast.success(`Saved "${saved.name}"`);
    if (connect) await useApp.getState().connect(saved.id);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader className="flex-row items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-sky-500 text-white shadow-sm">
            <Server className="size-5" />
          </span>
          <div>
            <DialogTitle>{editing?.id ? `Edit ${editing.name}` : 'New connection'}</DialogTitle>
            <DialogDescription>MySQL 5.7+, 8.x, 9.x and MariaDB</DialogDescription>
          </div>
        </DialogHeader>

        <div className="max-h-[62vh] space-y-4 overflow-y-auto px-5 pb-1">
          <div className="relative">
            <Link2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={(e) => applyUrl(e.clipboardData.getData('text'))}
              onKeyDown={(e) => e.key === 'Enter' && applyUrl(url)}
              placeholder="Paste a URL: mysql://user:password@host:3306/database"
              className="border-dashed pl-8 font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-6 gap-3">
            <Field label="Name" className="col-span-4">
              <Input value={c.name} onChange={(e) => set('name', e.target.value)} placeholder={`${c.user || 'user'}@${c.host || 'host'}`} autoFocus />
            </Field>
            <Field label="Color" className="col-span-2">
              <div className="flex h-8 items-center gap-1.5">
                {COLORS.map((col) => (
                  <button
                    key={col || 'none'}
                    type="button"
                    title={col || 'none'}
                    onClick={() => set('color', col)}
                    className={cn('size-5 rounded-full border-2 border-transparent transition-transform hover:scale-110', c.color === col && 'ring-2 ring-ring ring-offset-2 ring-offset-popover', !col && 'border-border')}
                    style={{ backgroundColor: col ? colorOf(col) : 'transparent' }}
                  />
                ))}
              </div>
            </Field>
            <Field label="Host" className="col-span-4">
              <Input value={c.host} onChange={(e) => set('host', e.target.value)} placeholder="127.0.0.1" className="font-mono" />
            </Field>
            <Field label="Port" className="col-span-2">
              <Input value={c.port} onChange={(e) => set('port', Number(e.target.value) || 3306)} inputMode="numeric" className="font-mono" />
            </Field>
            <Field label="User" className="col-span-3">
              <Input value={c.user} onChange={(e) => set('user', e.target.value)} placeholder="root" />
            </Field>
            <Field label="Password" className="col-span-3">
              <div className="relative">
                <Input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={editing?.id ? '•••••• (unchanged)' : ''} className="pr-8" />
                <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            <Field label="Default database" className="col-span-6" hint="Optional. All databases stay visible in the explorer.">
              <Input value={c.database ?? ''} onChange={(e) => set('database', e.target.value)} placeholder="optional" />
            </Field>
          </div>

          <Section icon={<KeyRound />} title="SSH tunnel" desc="Reach a database on a private network" on={!!c.ssh} onToggle={(on) => set('ssh', on ? { host: '', port: 22, user: '', auth: 'key', keyPath: '~/.ssh/id_ed25519' } : undefined)}>
            {c.ssh && (
              <>
                <Field label="SSH host" className="col-span-4">
                  <Input value={c.ssh.host} onChange={(e) => set('ssh', { ...c.ssh!, host: e.target.value })} placeholder="bastion.example.com" />
                </Field>
                <Field label="Port" className="col-span-2">
                  <Input value={c.ssh.port} onChange={(e) => set('ssh', { ...c.ssh!, port: Number(e.target.value) || 22 })} />
                </Field>
                <Field label="SSH user" className="col-span-2">
                  <Input value={c.ssh.user} onChange={(e) => set('ssh', { ...c.ssh!, user: e.target.value })} placeholder="ubuntu" />
                </Field>
                <Field label="Authentication" className="col-span-4">
                  <div className="grid h-8 grid-cols-3 rounded-md bg-muted p-0.5 text-xs">
                    {(['key', 'password', 'agent'] as const).map((a) => (
                      <button key={a} type="button" onClick={() => set('ssh', { ...c.ssh!, auth: a })} className={cn('rounded-[5px] font-medium capitalize transition-colors', c.ssh!.auth === a ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                        {a === 'key' ? 'Private key' : a}
                      </button>
                    ))}
                  </div>
                </Field>
                {c.ssh.auth === 'key' && (
                  <>
                    <Field label="Private key file" className="col-span-4" hint="Empty = try ~/.ssh keys, like ssh does.">
                      <Input value={c.ssh.keyPath ?? ''} onChange={(e) => set('ssh', { ...c.ssh!, keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" className="font-mono text-xs" />
                    </Field>
                    <Field label="Passphrase" className="col-span-2">
                      <Input type="password" value={sshSecret} onChange={(e) => setSshSecret(e.target.value)} placeholder="if any" />
                    </Field>
                  </>
                )}
                {c.ssh.auth === 'password' && (
                  <Field label="SSH password" className="col-span-6">
                    <Input type="password" value={sshSecret} onChange={(e) => setSshSecret(e.target.value)} placeholder={editing?.id ? '•••••• (unchanged)' : ''} />
                  </Field>
                )}
              </>
            )}
          </Section>

          <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn('size-3.5 transition-transform', !advanced && '-rotate-90')} /> Advanced
          </button>
          {advanced && (
            <div className="space-y-2">
              <Section icon={<ShieldCheck />} title="SSL / TLS" desc="Required by most cloud databases" on={!!c.ssl} onToggle={(on) => set('ssl', on)}>
                <span className="col-span-6 text-xs text-muted-foreground">Server certificate is verified. CA / client certificate files can be added here.</span>
              </Section>
              <Section icon={<Lock />} title="Read-only" desc="Block writes; editing and imports are disabled" on={!!c.readOnly} onToggle={(on) => set('readOnly', on)}>
                <span className="col-span-6 text-xs text-muted-foreground">Sessions start with SET SESSION TRANSACTION READ ONLY.</span>
              </Section>
            </div>
          )}
        </div>

        <DialogFooter className="justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void runTest()} disabled={test.state === 'busy'}>
              {test.state === 'busy' ? <Loader2 className="animate-spin" /> : null}
              Test
            </Button>
            {test.state === 'ok' && (
              <span className="flex min-w-0 items-center gap-1 truncate text-xs text-success">
                <CheckCircle2 className="size-3.5 shrink-0" /> {test.msg}
              </span>
            )}
            {test.state === 'err' && (
              <span className="flex min-w-0 items-center gap-1 truncate text-xs text-destructive" title={test.msg}>
                <XCircle className="size-3.5 shrink-0" /> {test.msg}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={() => void save(false)}>
              Save
            </Button>
            <Button size="sm" onClick={() => void save(true)}>
              Save & Connect
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
