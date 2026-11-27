import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, Copy, ExternalLink, Eye, EyeOff, Globe, LogOut, RefreshCw, Settings, Wifi } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { backend } from '@/lib/backend';
import type { WebSettings, WebStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, Switch } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ask } from '@/components/AskDialog';
import { openMcp } from '@/components/McpPanel';

interface SettingsStore {
  open: boolean;
  web: WebStatus | null;
}

const useSettings = create<SettingsStore>(() => ({ open: false, web: null }));

export function openSettings() {
  useSettings.setState({ open: true });
}

const DEFAULT_PORT = 7431;

/** The link that signs a browser in: the address plus the token. */
const loginUrl = (base: string, token: string) => `${base}/login?token=${encodeURIComponent(token)}`;

async function openInBrowser(url: string) {
  try {
    if (backend.native) await openUrl(url);
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    toast.error('Could not open the browser', { description: String(e) });
  }
}

/** Loads the web access state once; shows it in the status bar. */
export function useWebStatus() {
  useEffect(() => {
    void backend.webStatus().then(
      (web) => useSettings.setState({ web }),
      () => undefined,
    );
  }, []);
}

export function WebIndicator() {
  const web = useSettings((s) => s.web);
  if (!web?.running) return null;
  return (
    <button onClick={openSettings} className="flex items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground" title="Web access">
      {web.settings.lan ? <Wifi className="size-3" /> : <Globe className="size-3" />}
      <span className="size-1.5 rounded-full bg-success" />
      Web :{web.port}
    </button>
  );
}

function WebAccess() {
  const status = useSettings((s) => s.web);
  const [draft, setDraft] = useState<WebSettings | null>(status?.settings ?? null);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setShowToken(false);
    void backend.webStatus().then((st) => {
      useSettings.setState({ web: st });
      setDraft(st?.settings ?? null);
    });
  }, []);

  const dirty = useMemo(() => !!draft && !!status && (draft.port !== status.settings.port || draft.lan !== status.settings.lan), [draft, status]);

  const save = async (next: WebSettings, done?: string) => {
    setSaving(true);
    try {
      const st = await backend.webSave(next);
      useSettings.setState({ web: st });
      setDraft(st.settings);
      if (st.error) toast.error('Web access did not start', { description: st.error });
      else toast.success(done ?? (st.running ? `Web access is on (port ${st.port})` : 'Web access is off'));
    } catch (e) {
      toast.error('Could not save', { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const setLan = async (lan: boolean) => {
    if (!draft) return;
    if (lan) {
      const ok = await ask({
        title: 'Allow other devices on the network?',
        description: 'Anyone on this network who has the link with the token can use every saved connection, including its passwords on the server side. The connection is plain HTTP (not encrypted), so use this only on networks you trust.',
        confirm: 'Allow',
        danger: true,
      });
      if (ok === null) return;
    }
    setDraft({ ...draft, lan });
  };

  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`));

  if (!draft || !status) return <div className="h-40" />;
  return (
    <div className="space-y-4">
      <section className="flex items-center gap-3 rounded-lg border p-3">
        <Switch checked={draft.enabled} onCheckedChange={(on) => void save({ ...draft, enabled: on })} disabled={saving} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Web server</div>
          <div className={cn('text-xs', status.error ? 'text-destructive' : 'text-muted-foreground')}>
            {status.error
              ? status.error
              : status.running
                ? status.settings.lan
                  ? `Listening on port ${status.port} for this computer and the local network`
                  : `Listening on http://127.0.0.1:${status.port} (this computer only)`
                : 'Off. Turn it on to use MySQL Lens from a web browser.'}
          </div>
        </div>
        {status.running && (
          <Badge variant="success">
            <CheckCircle2 className="size-3" /> On
          </Badge>
        )}
      </section>

      <section className="grid grid-cols-3 gap-3">
        <label className="space-y-1">
          <span className="text-xs font-medium">Port</span>
          <Input type="number" min={1024} max={65535} value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || DEFAULT_PORT })} />
        </label>
        <label className="col-span-2 flex cursor-pointer items-center gap-3 self-end rounded-lg border px-3 py-1.5">
          <Wifi className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Other devices</span>
            <span className="block text-[11px] text-muted-foreground">Phones and computers on the same network</span>
          </span>
          <Switch checked={draft.lan} onCheckedChange={(on) => void setLan(on)} />
        </label>
      </section>
      {draft.lan && (
        <p className="flex items-start gap-1.5 rounded-md bg-warning/10 px-2.5 py-2 text-[11.5px] text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" /> Traffic is not encrypted. Use this only on a network you trust, and turn it off when you are done.
        </p>
      )}
      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">{draft.enabled ? 'The server restarts with the new settings.' : 'Saved for the next start.'}</span>
          <Button size="sm" onClick={() => void save(draft, 'Web access settings saved')} disabled={saving}>
            Apply
          </Button>
        </div>
      )}

      {status.running && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Open in a browser</h3>
          <div className="divide-y rounded-lg border">
            {status.urls.map((u, i) => (
              <div key={u} className="flex items-center gap-2 px-3 py-2">
                {i === 0 ? <Globe className="size-4 shrink-0 text-muted-foreground" /> : <Wifi className="size-4 shrink-0 text-muted-foreground" />}
                <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{u}</code>
                <span className="shrink-0 text-[11px] text-muted-foreground">{i === 0 ? 'this computer' : 'other devices'}</span>
                <Button size="icon-xs" variant="ghost" title="Copy sign-in link (includes the token)" onClick={() => copy(loginUrl(u, draft.token), 'Sign-in link')}>
                  <Copy />
                </Button>
                {i === 0 && (
                  <Button size="icon-xs" variant="ghost" title="Open" onClick={() => void openInBrowser(loginUrl(u, draft.token))}>
                    <ExternalLink />
                  </Button>
                )}
              </div>
            ))}
            {status.settings.lan && status.urls.length < 2 && <div className="px-3 py-2 text-xs text-muted-foreground">No network address found. Use this computer's IP address with port {status.port}.</div>}
          </div>
        </section>
      )}

      <section className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="mr-auto">Access token (signs a browser in)</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{showToken ? draft.token : `${draft.token.slice(0, 6)}…`}</code>
        <Button size="icon-xs" variant="ghost" title={showToken ? 'Hide' : 'Show'} onClick={() => setShowToken((v) => !v)}>
          {showToken ? <EyeOff /> : <Eye />}
        </Button>
        <Button size="icon-xs" variant="ghost" title="Copy" onClick={() => copy(draft.token, 'Token')}>
          <Copy />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title="New token (signs every browser out)"
          onClick={async () => {
            if ((await ask({ title: 'Create a new token?', description: 'Every browser that is signed in is signed out and needs the new link.', confirm: 'New token', danger: true })) === null) return;
            void save({ ...status.settings, token: '' }, 'New token created; browsers were signed out');
          }}
        >
          <RefreshCw />
        </Button>
      </section>
    </div>
  );
}

/** Shown in a browser: web access is managed by the desktop app. */
function InBrowser() {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">You are using MySQL Lens in a browser through the desktop app's web access. Its settings can be changed only in the desktop app.</p>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          await fetch('/api/logout', { method: 'POST', headers: { 'x-lens': '1' } }).catch(() => undefined);
          location.assign('/login');
        }}
      >
        <LogOut /> Sign out
      </Button>
    </div>
  );
}

export function SettingsDialog() {
  const open = useSettings((s) => s.open);
  const close = () => useSettings.setState({ open: false });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[calc(100vh-48px)] max-w-xl flex-col gap-0">
        <DialogHeader className="border-b">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="size-5 text-primary" /> Settings
          </DialogTitle>
          <DialogDescription>Web access lets you use MySQL Lens from a browser while this app is running.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
              <Globe className="size-4 text-muted-foreground" /> Web access
            </h3>
            {open && (backend.web ? <InBrowser /> : <WebAccess />)}
          </div>
          <button
            onClick={() => {
              close();
              openMcp();
            }}
            className="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-accent"
          >
            <Bot className="size-4 text-muted-foreground" />
            <span className="flex-1">
              <span className="block text-[13px] font-medium">AI access (MCP)</span>
              <span className="block text-[11px] text-muted-foreground">Let Claude Code, Cursor or VS Code use your connections</span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </button>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
