import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DataEditor, {
  CompactSelection,
  GridCellKind,
  GridColumnIcon,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import type { Cell, Column } from '@/lib/types';
import { useApp } from '@/lib/store';

export interface DataGridProps {
  columns: Column[];
  rowCount: number;
  value: (row: number, col: number) => Cell;
  rowState?: (row: number) => 'new' | 'deleted' | undefined;
  isModified?: (row: number, col: number) => boolean;
  editable?: boolean;
  onEdit?: (row: number, col: number, value: Cell) => void;
  onAppendRow?: () => void;
  onDeleteRows?: (rows: number[]) => void;
  onActiveRow?: (row: number | undefined) => void;
  sort?: { column: string; dir: 'asc' | 'desc' } | null;
  onSort?: (column: string) => void;
  /** Changes whenever the underlying data is replaced, to reset widths/selection. */
  dataKey?: string;
}

/** Converts any CSS color (oklch, var(...)) to rgb(), which Glide can parse and blend. */
function cssColors(names: string[]): Record<string, string> {
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const out: Record<string, string> = {};
  for (const n of names) {
    probe.style.color = `var(${n})`;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = getComputedStyle(probe).color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    out[n] = a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  }
  probe.remove();
  return out;
}

function useGridTheme(): Partial<Theme> {
  const theme = useApp((s) => s.theme);
  return useMemo(() => {
    const c = cssColors(['--primary', '--primary-foreground', '--foreground', '--muted-foreground', '--background', '--border', '--grid-header', '--accent', '--popover', '--grid-row-alt', '--card']);
    return {
      accentColor: c['--primary'],
      accentFg: c['--primary-foreground'],
      accentLight: c['--primary'].replace('rgb(', 'rgba(').replace(')', ', 0.16)'),
      textDark: c['--foreground'],
      textMedium: c['--muted-foreground'],
      textLight: c['--muted-foreground'],
      textBubble: c['--foreground'],
      bgIconHeader: c['--muted-foreground'],
      fgIconHeader: c['--background'],
      textHeader: c['--foreground'],
      textHeaderSelected: c['--primary-foreground'],
      bgCell: c['--background'],
      bgCellMedium: c['--grid-row-alt'],
      bgHeader: c['--grid-header'],
      bgHeaderHasFocus: c['--accent'],
      bgHeaderHovered: c['--accent'],
      bgBubble: c['--accent'],
      bgBubbleSelected: c['--primary'],
      bgSearchResult: 'rgba(250, 204, 21, 0.35)',
      borderColor: c['--border'],
      horizontalBorderColor: c['--border'],
      drilldownBorder: c['--border'],
      linkColor: c['--primary'],
      cellHorizontalPadding: 10,
      cellVerticalPadding: 4,
      headerFontStyle: '600 12.5px',
      baseFontStyle: '13px',
      markerFontStyle: '11.5px',
      fontFamily: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      editorFontSize: '13px',
      lineHeight: 1.45,
      roundingRadius: 6,
    } satisfies Partial<Theme>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}

function iconFor(c: Column): GridColumnIcon {
  if (c.pk) return GridColumnIcon.HeaderRowID;
  const t = c.type.toLowerCase();
  if (t === 'tinyint(1)' || t.startsWith('bool')) return GridColumnIcon.HeaderBoolean;
  if (c.numeric) return GridColumnIcon.HeaderNumber;
  if (/date|time|year/.test(t)) return GridColumnIcon.HeaderDate;
  if (t.startsWith('enum') || t.startsWith('set')) return GridColumnIcon.HeaderSingleValue;
  if (t === 'json') return GridColumnIcon.HeaderCode;
  if (/text|blob/.test(t)) return GridColumnIcon.HeaderTextTemplate;
  return GridColumnIcon.HeaderString;
}

const isBool = (c: Column) => /^(tinyint\(1\)|bool|boolean)$/i.test(c.type);

export function DataGrid(p: DataGridProps) {
  const theme = useGridTheme();
  const ref = useRef<DataEditorRef>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  const [showSearch, setShowSearch] = useState(false);

  // Initial column widths from a sample of the data.
  useEffect(() => {
    const w: Record<string, number> = {};
    p.columns.forEach((c, ci) => {
      let len = Math.max(c.name.length + 4, c.type.length * 0.6);
      for (let r = 0; r < Math.min(p.rowCount, 60); r++) {
        const v = p.value(r, ci);
        len = Math.max(len, v === null ? 4 : Math.min(String(v).length, 48));
      }
      w[c.name] = Math.round(Math.min(340, Math.max(76, len * 7.4 + 34)));
    });
    setWidths(w);
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.dataKey]);

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      p.columns.map((c) => ({
        id: c.name,
        title: c.name + (p.sort?.column === c.name ? (p.sort.dir === 'asc' ? '  ↑' : '  ↓') : ''),
        width: widths[c.name] ?? 140,
        icon: iconFor(c),
        hasMenu: false,
        themeOverride: c.pk ? { bgIconHeader: '#d4a017' } : undefined,
      })),
    [p.columns, widths, p.sort],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const c = p.columns[col];
      const v = p.value(row, col);
      const state = p.rowState?.(row);
      const modified = p.isModified?.(row, col);
      const readonly = !p.editable || state === 'deleted';
      const themeOverride = modified ? { bgCell: 'rgba(234, 179, 8, 0.18)' } : undefined;
      if (v === null) {
        const isNewDefault = state === 'new' && !modified;
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: isNewDefault ? (c.autoIncrement ? 'auto' : c.defaultValue != null ? 'default' : 'NULL') : 'NULL',
          allowOverlay: true,
          readonly,
          themeOverride: { ...themeOverride, textDark: theme.textLight },
        };
      }
      if (isBool(c)) {
        return { kind: GridCellKind.Boolean, data: Number(v) === 1, allowOverlay: false, readonly, themeOverride };
      }
      const s = String(v);
      return {
        kind: GridCellKind.Text,
        data: s,
        displayData: s.length > 300 ? s.slice(0, 300) + '…' : s.replace(/\r?\n/g, ' ↵ '),
        allowOverlay: true,
        readonly,
        contentAlign: c.numeric ? 'right' : undefined,
        themeOverride,
      };
    },
    [p, theme.textLight],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, cell: EditableGridCell) => {
      if (!p.onEdit) return;
      if (cell.kind === GridCellKind.Boolean) p.onEdit(row, col, cell.data ? 1 : 0);
      else if (cell.kind === GridCellKind.Text) p.onEdit(row, col, cell.data);
    },
    [p],
  );

  const getRowThemeOverride = useCallback(
    (row: number) => {
      const s = p.rowState?.(row);
      if (s === 'deleted') return { bgCell: 'rgba(239, 68, 68, 0.14)', textDark: theme.textLight };
      if (s === 'new') return { bgCell: 'rgba(34, 197, 94, 0.12)' };
      return undefined;
    },
    [p, theme.textLight],
  );

  const onDelete = useCallback(
    (sel: GridSelection): boolean | GridSelection => {
      if (!p.editable) return false;
      const rows = sel.rows.toArray();
      if (rows.length) {
        p.onDeleteRows?.(rows);
        return false;
      }
      // Clearing cells sets them to NULL where allowed.
      const r = sel.current?.range;
      if (r && p.onEdit) {
        for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) if (p.columns[x].nullable !== false) p.onEdit(y, x, null);
      }
      return false;
    },
    [p],
  );

  return (
    <div className="relative h-full w-full" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
    }}>
      <DataEditor
        ref={ref}
        theme={theme}
        columns={gridColumns}
        rows={p.rowCount}
        getCellContent={getCellContent}
        onCellEdited={onCellEdited}
        getCellsForSelection
        onPaste
        fillHandle={p.editable}
        rowMarkers={{ kind: 'both', checkboxStyle: 'square' }}
        rowMarkerWidth={52}
        smoothScrollX
        smoothScrollY
        rowHeight={30}
        headerHeight={34}
        width="100%"
        height="100%"
        gridSelection={selection}
        onGridSelectionChange={(s) => {
          setSelection(s);
          const row = s.current?.cell[1] ?? s.rows.first();
          p.onActiveRow?.(row);
        }}
        onColumnResize={(c, w) => setWidths((x) => ({ ...x, [c.id as string]: w }))}
        onHeaderClicked={(col) => p.onSort?.(p.columns[col].name)}
        getRowThemeOverride={getRowThemeOverride}
        trailingRowOptions={p.editable && p.onAppendRow ? { hint: 'New row', sticky: true, tint: true } : undefined}
        onRowAppended={p.editable && p.onAppendRow ? () => p.onAppendRow!() : undefined}
        onDelete={onDelete}
        showSearch={showSearch}
        onSearchClose={() => setShowSearch(false)}
        keybindings={{ search: true, selectAll: true, copy: true, paste: true, clear: true, downFill: true, rightFill: true }}
        scaleToRem={false}
      />
    </div>
  );
}
