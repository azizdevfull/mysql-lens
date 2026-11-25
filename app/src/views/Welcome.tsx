import { ArrowRight, Command, Database, FilePlus2, Plus, Server } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/misc';
import { colorOf } from './QueryView';

export function Welcome() {
  const connections = useApp((s) => s.connections);
  const connState = useApp((s) => s.connState);
  const { openConnDialog, openQuery, setPalette, connect } = useApp.getState();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 pt-[9vh] pb-16">
        <div className="flex items-center gap-4">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-sky-400 text-white shadow-lg shadow-blue-500/25">
            <Database className="size-7" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">MySQL Lens</h1>
            <p className="text-muted-foreground">Fast, lightweight MySQL & MariaDB client · unlimited connections</p>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-3 gap-3">
          {[
            { icon: <Plus />, title: 'New connection', desc: 'MySQL, MariaDB, SSH, SSL', run: () => openConnDialog() },
            { icon: <FilePlus2 />, title: 'New query', desc: 'SQL editor with autocomplete', run: () => openQuery() },
            { icon: <Command />, title: 'Quick open', desc: 'Jump to any table · Ctrl K', run: () => setPalette(true) },
          ].map((a) => (
            <button key={a.title} onClick={a.run} className="group flex flex-col items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary [&_svg]:size-4">{a.icon}</span>
              <span>
                <span className="block font-medium">{a.title}</span>
                <span className="block text-xs text-muted-foreground">{a.desc}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-10 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Connections</h2>
          <Button size="sm" variant="ghost" onClick={() => setPalette(true)}>
            <Command /> Quick open <Kbd>Ctrl K</Kbd>
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {connections.map((c) => (
            <button
              key={c.id}
              onClick={async () => {
                if (await connect(c.id)) openQuery(c.id, c.database);
              }}
              className="group flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
            >
              <span className="relative flex size-9 items-center justify-center rounded-lg bg-muted">
                <Server className="size-4" style={{ color: colorOf(c.color) }} />
                {connState[c.id] === 'on' && <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card bg-success" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {c.user}@{c.host}:{c.port}
                  {c.ssh && ' · SSH'}
                </span>
              </span>
              <ArrowRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>

        <div className="mt-10 grid grid-cols-2 gap-x-8 gap-y-2.5 text-[13px]">
          {[
            ['Ctrl K', 'Search tables & commands'],
            ['Ctrl N', 'New query'],
            ['Ctrl Enter', 'Run statement'],
            ['Ctrl Space', 'Autocomplete'],
            ['Ctrl S', 'Save table changes'],
            ['Ctrl F', 'Search in grid'],
          ].map(([k, d]) => (
            <div key={k} className="flex items-center justify-between border-b border-dashed pb-2">
              <span className="text-muted-foreground">{d}</span>
              <Kbd>{k}</Kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
