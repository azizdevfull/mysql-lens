import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { backend } from '@/lib/backend';
import type { ExportFormat } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/menu';

const FORMATS: { f: ExportFormat; label: string }[] = [
  { f: 'csv', label: 'CSV' },
  { f: 'xlsx', label: 'Excel (.xlsx)' },
  { f: 'json', label: 'JSON' },
  { f: 'sql', label: 'SQL INSERT' },
  { f: 'tsv', label: 'TSV' },
  { f: 'markdown', label: 'Markdown' },
];

/** Export dropdown: table (sql = '') or the given query, streamed by the backend. */
export function ExportMenu({ connId, db, table, sql, label, className }: { connId: string; db: string; table: string; sql: string; label: string; className?: string }) {
  const run = async (f: ExportFormat) => {
    const id = toast.loading(`Exporting ${table}…`);
    try {
      const r = await backend.exportData(connId, db, table, sql, f);
      if (!r) return toast.dismiss(id);
      toast.success(`Exported ${r.rows.toLocaleString()} rows`, {
        id,
        description: r.path,
        action: backend.native ? { label: 'Show file', onClick: () => void backend.revealFile(r.path) } : undefined,
      });
    } catch (e) {
      toast.error('Export failed', { id, description: String(e) });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className={className}>
          <Download /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {FORMATS.map((x) => (
          <DropdownMenuItem key={x.f} onSelect={() => void run(x.f)}>
            {x.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
