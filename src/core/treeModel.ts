import type { SchemaService } from '../schema';
import { formatBytes, formatCount } from '../sql';

/* Tree of connections → databases → objects, shared by VS Code and the desktop app. */

export type NodeKind =
  | 'connection'
  | 'database'
  | 'folder'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'message';

export type FolderKind = 'tables' | 'views' | 'procedures' | 'functions' | 'triggers' | 'indexes';

export interface Node {
  kind: NodeKind;
  connId: string;
  db?: string;
  /** Table/view/routine/trigger/column name. */
  name?: string;
  /** Owning table for columns and indexes. */
  table?: string;
  folder?: FolderKind;
  label?: string;
  description?: string;
  tooltip?: string;
  pk?: boolean;
}

export const FOLDER_LABEL: Record<FolderKind, string> = {
  tables: 'Tables',
  views: 'Views',
  procedures: 'Procedures',
  functions: 'Functions',
  triggers: 'Triggers',
  indexes: 'Indexes',
};

export async function treeChildren(n: Node, schema: SchemaService): Promise<Node[]> {
  const { connId, db } = n;
  switch (n.kind) {
    case 'connection': {
      const dbs = await schema.databases(connId);
      if (!dbs.length) {
        return [{ kind: 'message', connId, label: 'No databases' }];
      }
      return dbs.map((d) => ({ kind: 'database', connId, db: d }));
    }
    case 'database': {
      const [tables, routines, triggers] = await Promise.all([
        schema.tables(connId, db!),
        schema.routines(connId, db!),
        schema.triggers(connId, db!),
      ]);
      const tableCount = tables.filter((t) => t.kind === 'table').length;
      const viewCount = tables.length - tableCount;
      const procs = routines.filter((r) => r.kind === 'procedure').length;
      const funcs = routines.length - procs;
      const out: Node[] = [{ kind: 'folder', connId, db, folder: 'tables', description: String(tableCount) }];
      if (viewCount) { out.push({ kind: 'folder', connId, db, folder: 'views', description: String(viewCount) }); }
      if (procs) { out.push({ kind: 'folder', connId, db, folder: 'procedures', description: String(procs) }); }
      if (funcs) { out.push({ kind: 'folder', connId, db, folder: 'functions', description: String(funcs) }); }
      if (triggers.length) { out.push({ kind: 'folder', connId, db, folder: 'triggers', description: String(triggers.length) }); }
      return out;
    }
    case 'folder': {
      switch (n.folder) {
        case 'tables':
        case 'views': {
          const kind = n.folder === 'tables' ? 'table' : 'view';
          const tables = (await schema.tables(connId, db!)).filter((t) => t.kind === kind);
          return tables.map((t) => ({
            kind,
            connId,
            db,
            name: t.name,
            description: kind === 'table' ? [t.rows !== null ? `~${formatCount(t.rows)} rows` : '', t.dataBytes ? formatBytes(t.dataBytes) : ''].filter(Boolean).join(' · ') : undefined,
            tooltip: [t.name, t.engine ? `Engine: ${t.engine}` : '', t.comment].filter(Boolean).join('\n'),
          }));
        }
        case 'procedures':
        case 'functions': {
          const kind = n.folder === 'procedures' ? 'procedure' : 'function';
          return (await schema.routines(connId, db!)).filter((r) => r.kind === kind).map((r) => ({ kind, connId, db, name: r.name }));
        }
        case 'triggers':
          return (await schema.triggers(connId, db!)).map((t) => ({ kind: 'trigger', connId, db, name: t }));
        case 'indexes':
          return (await schema.indexes(connId, db!, n.table!)).map((i) => ({
            kind: 'index',
            connId,
            db,
            table: n.table,
            name: i.name,
            description: `${i.unique ? 'UNIQUE ' : ''}(${i.columns.join(', ')})`,
          }));
      }
      return [];
    }
    case 'table':
    case 'view': {
      const cols = await schema.columns(connId, db!, n.name!);
      const nodes: Node[] = cols.map((c) => ({
        kind: 'column',
        connId,
        db,
        table: n.name,
        name: c.name,
        pk: c.key === 'PRI',
        description: `${c.columnType}${c.nullable ? '' : ' NOT NULL'}${c.extra ? ' ' + c.extra : ''}`,
        tooltip: [
          `${c.name} ${c.columnType}`,
          c.nullable ? 'NULL' : 'NOT NULL',
          c.defaultValue !== null ? `DEFAULT ${c.defaultValue}` : '',
          c.extra,
          c.comment ? `— ${c.comment}` : '',
        ].filter(Boolean).join(' '),
      }));
      if (n.kind === 'table') {
        const idx = await schema.indexes(connId, db!, n.name!);
        if (idx.length) {
          nodes.push({ kind: 'folder', connId, db, table: n.name, folder: 'indexes', description: String(idx.length) });
        }
      }
      return nodes;
    }
    default:
      return [];
  }
}
