import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { AlertCircle, AlertTriangle, Bot, CheckCircle2, Copy, Eye, EyeOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { backend } from '@/lib/backend';
import { useApp } from '@/lib/store';
import { isProduction } from '@/lib/sqlSafety';
import type { McpAccess, McpActivity, McpApproval, McpSettings, McpStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, Switch } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ask } from '@/components/AskDialog';
import { colorOf } from '@/views/QueryView';

interface ActivityItem extends McpActivity {
  at: number;
}

interface McpStore {
  open: boolean;
  status: McpStatus | null;
  activity: ActivityItem[];
  /** Writes waiting for the user, oldest first. */
  approvals: (McpApproval & { at: number })[];
}

const useMcp = create<McpStore>(() => ({ open: false, status: null, activity: [], approvals: [] }));

// Lets the browser demo show an approval request (development builds only).
if (import.meta.env.DEV) (window as unknown as { __mcp: typeof useMcp }).__mcp = useMcp;

export function openMcp() {
  useMcp.setState({ open: true });
}

const refresh = () =>
  backend.mcpStatus().then(
    (status) => useMcp.setState({ status }),
    () => undefined,
  );

/** Subscribes to AI approvals and activity; mount once in the app. */
export function useMcpEvents() {
  useEffect(() => {
    void refresh();
    let off: (() => void)[] = [];
    let live = true;
    void Promise.all([
      backend.onMcpApproval(
        (a) => useMcp.setState((s) => ({ approvals: [...s.approvals, { ...a, at: Date.now() }] })),
        (id) => {
          useMcp.setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== id) }));
          toast.warning('An AI change request expired', { description: 'It was not answered within 2 minutes, so it was rejected.' });
        },
      ),
      backend.onMcpActivity((a) => {
        useMcp.setState((s) => ({ activity: [{ ...a, at: Date.now() }, ...s.activity].slice(0, 50) }));
        if (a.tool === 'execute' && a.ok) toast.success(`${a.client} changed data on ${a.connName}`, { description: a.sql.slice(0, 140) });
      }),
    ]).then((fns) => {
      if (live) off = fns;
      else fns.forEach((f) => f());
    });
    return () => {
      live = false;
      off.forEach((f) => f());
    };
  }, []);
}

/* ----------------------------- status bar ----------------------------- */

export function McpIndicator() {
  const status = useMcp((s) => s.status);
  const pending = useMcp((s) => s.approvals.length);
  if (!status) return null;
  const on = status.running;
  return (
    <button onClick={openMcp} className="flex items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground" title="AI access (MCP)">
      <Bot className="size-3" />
      <span className={cn('size-1.5 rounded-full', on ? 'bg-success' : status.error ? 'bg-destructive' : 'bg-muted-foreground/50')} />
      {on ? `MCP :${status.port}` : 'MCP off'}
      {pending > 0 && <span className="rounded bg-warning/20 px-1 text-warning">{pending}</span>}
    </button>
  );
}

/* ----------------------------- settings ----------------------------- */

type Client = 'claude-code' | 'cursor' | 'vscode' | 'claude-desktop';

function configFor(client: Client, port: number, token: string): string {
  const url = `http://127.0.0.1:${port}/mcp`;
  const auth = `Bearer ${token}`;
  switch (client) {
    case 'claude-code':
      return `claude mcp add --transport http mysql-lens ${url} --header "Authorization: ${auth}"`;
    case 'cursor':
      return JSON.stringify({ mcpServers: { 'mysql-lens': { url, headers: { Authorization: auth } } } }, null, 2);
    case 'vscode':
      return JSON.stringify({ servers: { 'mysql-lens': { type: 'http', url, headers: { Authorization: auth } } } }, null, 2);
    case 'claude-desktop':
      return JSON.stringify({ mcpServers: { 'mysql-lens': { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH}'], env: { AUTH: auth } } } }, null, 2);
  }
}

const CLIENTS: { id: Client; label: string; hint: string }[] = [
  { id: 'claude-code', label: 'Claude Code', hint: 'Run in a terminal. Claude Code inside WSL reaches Windows’ 127.0.0.1 only with networkingMode=mirrored in %UserProfile%\\.wslconfig.' },
  { id: 'cursor', label: 'Cursor', hint: 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).' },
  { id: 'vscode', label: 'VS Code', hint: 'Add to .vscode/mcp.json in a project, or run “MCP: Add Server”.' },
  { id: 'claude-desktop', label: 'Claude Desktop', hint: 'Add to claude_desktop_config.json. Needs Node.js (npx).' },
];

const ACCESS: { value: McpAccess; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Read & write (approve each)' },
];

const when = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function McpDialog() {
  const open = useMcp((s) => s.open);
  const status = useMcp((s) => s.status);
  const activity = useMcp((s) => s.activity);
  const connections = useApp((s) => s.connections);
  const [draft, setDraft] = useState<McpSettings | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [client, setClient] = useState<Client>('claude-code');
  const [saving, setSaving] = useState(false);
  const close = () => useMcp.setState({ open: false });

  useEffect(() => {
    if (!open) return;
    setShowToken(false);
    void backend.mcpStatus().then((st) => {
      useMcp.setState({ status: st });
      setDraft(st.settings);
    });
  }, [open]);

  const dirty = useMemo(() => !!draft && !!status && JSON.stringify(draft) !== JSON.stringify(status.settings), [draft, status]);

  const save = async (next: McpSettings) => {
    setSaving(true);
    try {
      const st = await backend.mcpSave(next);
      useMcp.setState({ status: st });
      setDraft(st.settings);
      if (st.error) toast.error('The MCP server did not start', { description: st.error });
      else toast.success(st.running ? `AI access is on (port ${st.port})` : 'AI access is off');
    } catch (e) {
      toast.error('Could not save', { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const setAccess = async (connId: string, access: McpAccess) => {
    if (!draft) return;
    const c = connections.find((x) => x.id === connId);
    if (access === 'write' && isProduction(c)) {
      const ok = await ask({ title: `Let AI change data on ${c?.name}?`, description: 'This connection is tagged as production. Every write still needs your approval here, but read the SQL carefully before allowing it.', confirm: 'Allow writes', danger: true });
      if (ok === null) return;
    }
    setDraft({ ...draft, access: { ...draft.access, [connId]: access } });
  };

  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`));
  const enabledCount = draft ? connections.filter((c) => (draft.access[c.id] ?? 'off') !== 'off').length : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[calc(100vh-48px)] max-w-3xl flex-col gap-0">
        <DialogHeader className="border-b">
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5 text-primary" /> AI access (MCP)
          </DialogTitle>
          <DialogDescription>Let AI assistants such as Claude Code, Cursor or VS Code use your connections. They see only the connections you enable, and every write waits for your approval here.</DialogDescription>
        </DialogHeader>

        {draft && status && (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {/* Server */}
            <section className="flex items-center gap-3 rounded-lg border p-3">
              <Switch checked={draft.enabled} onCheckedChange={(on) => void save({ ...draft, enabled: on })} disabled={saving} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">MCP server</div>
                <div className={cn('text-xs', status.error ? 'text-destructive' : 'text-muted-foreground')}>
                  {status.error ? status.error : status.running ? `Listening on http://127.0.0.1:${status.port}/mcp (this computer only)` : 'Off. AI assistants cannot reach your databases.'}
                </div>
              </div>
              {status.running && (
                <Badge variant="success">
                  <CheckCircle2 className="size-3" /> On
                </Badge>
              )}
            </section>

            {/* Connections */}
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Connections ({enabledCount} enabled)</h3>
              <div className="divide-y rounded-lg border">
                {connections.length === 0 && <div className="p-3 text-[13px] text-muted-foreground">No connections yet.</div>}
                {connections.map((c) => {
                  const access = draft.access[c.id] ?? 'off';
                  return (
                    <div key={c.id} className="flex items-center gap-2 px-3 py-2">
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colorOf(c.color) }} />
                      <span className="truncate text-[13px]">{c.name}</span>
                      {isProduction(c) && <Badge variant="destructive" className="h-4 px-1 text-[10px]">production</Badge>}
                      {c.readOnly && <Badge variant="secondary" className="h-4 px-1 text-[10px]">read-only connection</Badge>}
                      <select
                        value={c.readOnly && access === 'write' ? 'read' : access}
                        onChange={(e) => void setAccess(c.id, e.target.value as McpAccess)}
                        className={cn('ml-auto h-7 rounded-md border bg-background px-2 text-xs outline-none dark:bg-input/30', access === 'write' && 'border-warning/60 text-warning', access === 'read' && 'border-primary/50 text-primary')}
                      >
                        {ACCESS.filter((a) => !(c.readOnly && a.value === 'write')).map((a) => (
                          <option key={a.value} value={a.value} className="bg-popover text-foreground">
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
              <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-muted-foreground">
                <ShieldCheck className="mt-px size-3.5 shrink-0" /> Read queries run in a read-only transaction, so the server itself refuses changes. Writes show up here for you to allow or reject.
              </p>
            </section>

            {/* Limits */}
            <section className="grid grid-cols-3 gap-3">
              <label className="space-y-1">
                <span className="text-xs font-medium">Port</span>
                <Input type="number" min={1024} max={65535} value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || 7421 })} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium">Rows per result</span>
                <Input type="number" min={1} max={10000} value={draft.maxRows} onChange={(e) => setDraft({ ...draft, maxRows: Math.max(1, Number(e.target.value) || 200) })} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium">Query time limit (s)</span>
                <Input type="number" min={1} max={3600} value={draft.timeoutSecs} onChange={(e) => setDraft({ ...draft, timeoutSecs: Math.max(1, Number(e.target.value) || 30) })} />
              </label>
            </section>

            {/* Connect a client */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground">Connect an AI assistant</h3>
                <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                  Token
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{showToken ? draft.token : `${draft.token.slice(0, 6)}…`}</code>
                  <Button size="icon-xs" variant="ghost" title={showToken ? 'Hide' : 'Show'} onClick={() => setShowToken((v) => !v)}>
                    {showToken ? <EyeOff /> : <Eye />}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title="New token (connected assistants must be set up again)"
                    onClick={async () => {
                      if ((await ask({ title: 'Create a new token?', description: 'Assistants set up with the old token stop working until you copy the new configuration.', confirm: 'New token', danger: true })) === null) return;
                      void save({ ...draft, token: '' });
                    }}
                  >
                    <RefreshCw />
                  </Button>
                </div>
              </div>
              <div className="mb-2 flex gap-1">
                {CLIENTS.map((x) => (
                  <button key={x.id} onClick={() => setClient(x.id)} className={cn('h-7 rounded-md px-2.5 text-xs font-medium', client === x.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                    {x.label}
                  </button>
                ))}
              </div>
              <div className="relative">
                <pre className="max-h-44 overflow-auto rounded-lg border bg-muted/50 p-3 pr-10 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">{configFor(client, status.port ?? draft.port, draft.token)}</pre>
                <Button size="icon-xs" variant="ghost" className="absolute top-2 right-2" onClick={() => copy(configFor(client, status.port ?? draft.port, draft.token), 'Configuration')}>
                  <Copy />
                </Button>
              </div>
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">{CLIENTS.find((x) => x.id === client)?.hint} Keep the token private: it lets programs on this computer use the enabled connections.</p>
            </section>

            {/* Activity */}
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Recent AI activity</h3>
              {activity.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">Nothing yet. Requests appear here and in the query history (Ctrl+H).</p>
              ) : (
                <div className="max-h-48 divide-y overflow-y-auto rounded-lg border">
                  {activity.map((a, i) => (
                    <div key={i} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                      {a.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" /> : <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                      <div className="min-w-0 flex-1">
                        <div className="text-muted-foreground">
                          <span className="font-medium text-foreground">{a.client}</span> · {a.tool} · {a.connName}
                          {a.db && ` / ${a.db}`} · {when(a.at)} · {a.ms} ms
                        </div>
                        <div className="truncate font-mono text-[11px]">{a.sql}</div>
                        {a.error && <div className="truncate text-destructive">{a.error}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        <DialogFooter className="border-t">
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          <Button disabled={!dirty || saving} onClick={() => draft && void save(draft)}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------- approval ----------------------------- */

/** Shown when an AI assistant wants to change data; it waits up to 2 minutes for an answer. */
export function McpApprovalDialog() {
  const queue = useMcp((s) => s.approvals);
  const connections = useApp((s) => s.connections);
  const current = queue[0];
  const conn = connections.find((c) => c.id === current?.connId);
  const prod = isProduction(conn);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!current) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [current]);

  const answer = (allow: boolean) => {
    if (!current) return;
    useMcp.setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== current.id) }));
    void backend.mcpApprove(current.id, allow);
  };

  const left = current ? Math.max(0, 120 - Math.floor((now - current.at) / 1000)) : 0;

  return (
    <Dialog open={!!current} onOpenChange={(o) => !o && answer(false)}>
      <DialogContent className="max-w-2xl" onEscapeKeyDown={() => answer(false)}>
        {current && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {prod ? <AlertTriangle className="size-5 text-destructive" /> : <Bot className="size-5 text-primary" />}
                {current.client} wants to change data
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-1.5">
                on <span className="size-2 rounded-full" style={{ backgroundColor: conn ? colorOf(conn.color) : undefined }} />
                <b className="text-foreground">{current.connName}</b>
                {current.db && <> / {current.db}</>}
                {prod && <Badge variant="destructive">production</Badge>}
                {queue.length > 1 && <span>· {queue.length - 1} more waiting</span>}
              </DialogDescription>
            </DialogHeader>
            <pre className={cn('mx-5 max-h-[45vh] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap', prod && 'border-destructive/50')}>{current.statements.map((s) => `${s.trim()};`).join('\n\n')}</pre>
            <DialogFooter>
              <span className="mr-auto text-xs text-muted-foreground tabular-nums">Rejected automatically in {left}s</span>
              <Button variant="outline" autoFocus onClick={() => answer(false)}>
                Reject
              </Button>
              <Button variant={prod ? 'destructive' : 'default'} onClick={() => answer(true)}>
                {prod ? 'Run on production' : 'Allow'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
