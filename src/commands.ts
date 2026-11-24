import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConnectionStore } from './connections/store';
import { ConnectionManager } from './connections/manager';
import { ConnectionConfig, defaultConfig } from './connections/types';
import { SchemaService } from './schema';
import { ConnectionTree, Node } from './tree/provider';
import { EditorSessions } from './query/editorSessions';
import { QueryHistory } from './query/history';
import { showConnectionForm, errorText } from './webviews/connectionForm';
import { exportQuery, ResultsPanel, TablePanel } from './webviews/gridPanel';
import { showImportPanel } from './webviews/importPanel';
import { pickFormat, pickSaveFile } from './io/exportFlow';
import { dumpDatabase } from './io/dump';
import { importSqlFile } from './io/sqlImport';
import { formatBytes, qid, qualified } from './sql';

interface Deps {
  ctx: vscode.ExtensionContext;
  store: ConnectionStore;
  conns: ConnectionManager;
  schema: SchemaService;
  tree: ConnectionTree;
  sessions: EditorSessions;
  history: QueryHistory;
}

export function registerCommands(d: Deps): vscode.Disposable[] {
  const { ctx, store, conns, schema, tree, sessions, history } = d;

  const refreshAll = () => {
    for (const c of store.list()) {
      schema.invalidate(c.id);
    }
    tree.refresh();
  };

  /** Resolves connection + database from a tree node, or asks. */
  const target = async (n?: Node, needDb = true): Promise<{ connId: string; db?: string } | undefined> => {
    if (n?.connId && (n.db || !needDb)) {
      return { connId: n.connId, db: n.db };
    }
    const ed = vscode.window.activeTextEditor;
    const bound = ed ? sessions.binding(ed.document.uri) : undefined;
    if (bound && (bound.database || !needDb) && !n) {
      return { connId: bound.connId, db: bound.database };
    }
    const b = await sessions.pickBinding(undefined, n?.connId ? { connId: n.connId } : undefined);
    if (!b) {
      return undefined;
    }
    if (needDb && !b.database) {
      void vscode.window.showWarningMessage('Choose a database.');
      return undefined;
    }
    return { connId: b.connId, db: b.database };
  };

  const guarded = (fn: (...args: any[]) => Promise<unknown> | unknown) => async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (e) {
      const msg = errorText(e);
      if (msg !== 'Cancelled.') {
        void vscode.window.showErrorMessage(`MySQL Studio: ${msg}`);
      }
    }
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, guarded(fn));

  return [
    reg('mysqlStudio.addConnection', () => showConnectionForm(ctx, store, conns)),
    reg('mysqlStudio.editConnection', (n: Node) => showConnectionForm(ctx, store, conns, { id: n.connId })),
    reg('mysqlStudio.duplicateConnection', (n: Node) => showConnectionForm(ctx, store, conns, { copyOf: n.connId })),
    reg('mysqlStudio.deleteConnection', async (n: Node) => {
      const c = store.get(n.connId);
      if (!c) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(`Delete connection "${c.name}"?`, { modal: true, detail: 'Saved passwords for it are removed too. Databases are not touched.' }, 'Delete');
      if (ok === 'Delete') {
        await conns.disconnect(c.id);
        await store.remove(c.id);
      }
    }),
    reg('mysqlStudio.refresh', (n?: Node) => {
      if (n?.connId) {
        schema.invalidate(n.connId, n.db);
        tree.refresh(n.kind === 'connection' || n.kind === 'database' ? n : undefined);
      } else {
        refreshAll();
      }
    }),
    reg('mysqlStudio.connect', async (n: Node) => {
      await vscode.window.withProgress({ location: { viewId: 'mysqlStudio.connections' }, title: 'Connecting…' }, () => conns.connect(n.connId));
    }),
    reg('mysqlStudio.disconnect', (n: Node) => conns.disconnect(n.connId)),

    reg('mysqlStudio.newQuery', (n?: Node) => sessions.newQuery(n?.connId, n?.db)),
    reg('mysqlStudio.runStatement', () => sessions.run('statement')),
    reg('mysqlStudio.runAll', () => sessions.run('all')),
    reg('mysqlStudio.rerun', (p: ResultsPanel) => sessions.rerun(p)),
    reg('mysqlStudio.selectConnection', () => {
      const ed = vscode.window.activeTextEditor;
      return ed ? sessions.pickBinding(ed.document.uri) : sessions.newQuery();
    }),
    reg('mysqlStudio.queryHistory', () => history.show()),

    reg('mysqlStudio.openTable', (n: Node) => TablePanel.open(ctx, conns, schema, n.connId, n.db!, n.name!, n.kind === 'view')),
    reg('mysqlStudio.showDdl', async (n: Node) => {
      const sql = await schema.createStatement(n.connId, n.db!, n.kind, n.name!);
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: (sql || `-- No definition available for ${n.name}`) + ';\n' });
      await sessions.setBinding(doc.uri, { connId: n.connId, database: n.db });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    reg('mysqlStudio.generateSelect', async (n: Node) => {
      const cols = await schema.columns(n.connId, n.db!, n.name!);
      const sql = `SELECT ${cols.map((c) => qid(c.name)).join(',\n       ')}\n  FROM ${qid(n.name!)}\n WHERE 1 = 1\n LIMIT 100;\n`;
      await sessions.newQuery(n.connId, n.db, sql);
    }),
    reg('mysqlStudio.generateInsert', async (n: Node) => {
      const cols = (await schema.columns(n.connId, n.db!, n.name!)).filter((c) => !/auto_increment|GENERATED/i.test(c.extra));
      const sql = `INSERT INTO ${qid(n.name!)}\n  (${cols.map((c) => qid(c.name)).join(', ')})\nVALUES\n  (${cols.map((c) => placeholder(c.dataType)).join(', ')});\n`;
      await sessions.newQuery(n.connId, n.db, sql);
    }),
    reg('mysqlStudio.generateUpdate', async (n: Node) => {
      const cols = await schema.columns(n.connId, n.db!, n.name!);
      const pk = cols.filter((c) => c.key === 'PRI');
      const set = cols.filter((c) => c.key !== 'PRI' && !/GENERATED/i.test(c.extra));
      const where = (pk.length ? pk : cols.slice(0, 1)).map((c) => `${qid(c.name)} = ${placeholder(c.dataType)}`).join(' AND ');
      const sql = `UPDATE ${qid(n.name!)}\n   SET ${set.map((c) => `${qid(c.name)} = ${placeholder(c.dataType)}`).join(',\n       ')}\n WHERE ${where};\n`;
      await sessions.newQuery(n.connId, n.db, sql);
    }),
    reg('mysqlStudio.copyName', async (n: Node) => {
      const name = n.kind === 'database' ? n.db! : n.name!;
      await vscode.env.clipboard.writeText(name);
      vscode.window.setStatusBarMessage(`$(check) Copied ${name}`, 2000);
    }),

    reg('mysqlStudio.createDatabase', async (n?: Node) => {
      const t = await target(n, false);
      if (!t) {
        return;
      }
      const name = await vscode.window.showInputBox({ title: 'Create database', prompt: 'Database name', validateInput: (v) => (v.trim() ? undefined : 'Required') });
      if (!name) {
        return;
      }
      const collation = await vscode.window.showQuickPick(['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_bin', 'utf8_general_ci', 'latin1_swedish_ci'], {
        title: 'Collation',
      });
      if (!collation) {
        return;
      }
      const charset = collation.split('_')[0];
      await conns.query(t.connId, `CREATE DATABASE ${qid(name.trim())} CHARACTER SET ${charset} COLLATE ${collation}`);
      schema.invalidate(t.connId);
      tree.refresh();
    }),
    reg('mysqlStudio.dropDatabase', async (n: Node) => {
      const typed = await vscode.window.showInputBox({
        title: `Drop database ${n.db}`,
        prompt: `This permanently deletes every table in "${n.db}". Type the database name to confirm.`,
        validateInput: (v) => (v === n.db ? undefined : 'Name does not match'),
      });
      if (typed !== n.db) {
        return;
      }
      await conns.query(n.connId, `DROP DATABASE ${qid(n.db!)}`);
      schema.invalidate(n.connId);
      tree.refresh();
    }),
    reg('mysqlStudio.truncateTable', async (n: Node) => {
      const ok = await vscode.window.showWarningMessage(`Delete all rows from ${n.db}.${n.name}?`, { modal: true, detail: 'TRUNCATE cannot be undone.' }, 'Truncate');
      if (ok !== 'Truncate') {
        return;
      }
      await conns.query(n.connId, `TRUNCATE TABLE ${qualified(n.db!, n.name!)}`);
      schema.invalidate(n.connId, n.db);
      tree.refresh();
      TablePanel.refreshAll(n.connId, n.db);
    }),
    reg('mysqlStudio.dropObject', async (n: Node) => {
      const what = n.kind.toUpperCase();
      const ok = await vscode.window.showWarningMessage(`Drop ${n.kind} ${n.db}.${n.name}?`, { modal: true, detail: 'This cannot be undone.' }, 'Drop');
      if (ok !== 'Drop') {
        return;
      }
      await conns.query(n.connId, `DROP ${what} ${qualified(n.db!, n.name!)}`);
      schema.invalidate(n.connId, n.db);
      tree.refresh();
    }),

    reg('mysqlStudio.exportTable', async (n: Node) => {
      const format = await pickFormat();
      if (!format) {
        return;
      }
      const file = await pickSaveFile(format, n.name!);
      if (!file) {
        return;
      }
      const meta = (await schema.tables(n.connId, n.db!)).find((t) => t.name === n.name);
      await exportQuery(conns, n.connId, n.db!, `SELECT * FROM ${qualified(n.db!, n.name!)}`, format, file, n.name!, meta?.rows ?? undefined);
    }),
    reg('mysqlStudio.exportDatabase', (n?: Node) => exportDatabase(n)),
    reg('mysqlStudio.importSql', (n?: Node) => importSql(n)),
    reg('mysqlStudio.importData', async (n?: Node) => {
      const t = await target(n);
      if (!t?.db) {
        return;
      }
      showImportPanel(ctx, conns, schema, t.connId, t.db, n?.kind === 'table' ? n.name : undefined, () => {
        tree.refresh();
        TablePanel.refreshAll(t.connId, t.db);
      });
    }),

    reg('mysqlStudio.exportConnections', async () => {
      const list = store.list();
      if (!list.length) {
        void vscode.window.showInformationMessage('No connections to export.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        list.map((c) => ({ label: c.name, description: `${c.user}@${c.host}:${c.port}`, picked: true, c })),
        { canPickMany: true, title: 'Export connections (passwords are not exported)' },
      );
      if (!picked?.length) {
        return;
      }
      const file = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'mysql-connections.json')),
        filters: { JSON: ['json'] },
      });
      if (!file) {
        return;
      }
      const data = { format: 'mysql-studio-connections', version: 1, connections: picked.map((p) => ({ ...p.c, id: undefined })) };
      await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(data, null, 2)));
      void vscode.window.showInformationMessage(`Exported ${picked.length} connection(s). Passwords were not included.`);
    }),
    reg('mysqlStudio.importConnections', async () => {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] } });
      if (!files?.[0]) {
        return;
      }
      const raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8'));
      const items: Partial<ConnectionConfig>[] = Array.isArray(raw) ? raw : (raw.connections ?? []);
      let n = 0;
      for (const it of items) {
        if (!it || typeof it !== 'object' || !it.host) {
          continue;
        }
        const base = defaultConfig();
        await store.save({
          ...base,
          ...it,
          id: randomUUID(),
          name: it.name || `${it.user ?? base.user}@${it.host}`,
          port: Number(it.port) || 3306,
          ssl: { ...base.ssl, ...(it.ssl ?? {}) },
          ssh: { ...base.ssh, ...(it.ssh ?? {}) },
        });
        n++;
      }
      void vscode.window.showInformationMessage(n ? `Imported ${n} connection(s). Open each one with "Edit Connection" to enter its password.` : 'No connections found in that file.');
    }),
  ];

  async function exportDatabase(n?: Node): Promise<void> {
    const t = await target(n);
    if (!t?.db) {
      return;
    }
    const db = t.db;
    const content = await vscode.window.showQuickPick(
      [
        { label: 'Structure and data', structure: true, data: true },
        { label: 'Structure only', structure: true, data: false },
        { label: 'Data only', structure: false, data: true },
      ],
      { title: `Export ${db} (1/3): content` },
    );
    if (!content) {
      return;
    }
    const tables = await schema.tables(t.connId, db);
    const pickedTables = await vscode.window.showQuickPick(
      tables.map((x) => ({
        label: x.name,
        description: x.kind === 'view' ? 'view' : [x.rows !== null ? `~${x.rows.toLocaleString()} rows` : '', x.dataBytes ? formatBytes(x.dataBytes) : ''].filter(Boolean).join(' · '),
        picked: true,
        name: x.name,
      })),
      { title: `Export ${db} (2/3): tables`, canPickMany: true, placeHolder: 'All tables are selected' },
    );
    if (!pickedTables) {
      return;
    }
    const opt = (label: string, key: string, picked: boolean, detail?: string) => ({ label, key, picked, detail });
    const extras = await vscode.window.showQuickPick(
      [
        opt('Add DROP … IF EXISTS before each object', 'drop', true),
        opt('Include CREATE DATABASE and USE', 'createDb', false, 'Restores into a database with the same name'),
        opt('Views', 'views', true),
        opt('Stored procedures and functions', 'routines', true),
        opt('Triggers', 'triggers', true),
      ],
      { title: `Export ${db} (3/3): options`, canPickMany: true },
    );
    if (!extras) {
      return;
    }
    const has = (k: string) => extras.some((e) => e.key === k);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const file = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(folder, `${db}_${stamp}.sql`)),
      filters: { 'SQL dump': ['sql'], 'Gzipped SQL dump': ['gz'] },
      saveLabel: 'Export',
    });
    if (!file) {
      return;
    }
    const conn = await conns.dedicated(t.connId, db);
    const version = await conns.serverVersion(t.connId);
    let cancelled = false;
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${db}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => (cancelled = true));
          let lastIndex = -1;
          return dumpDatabase(
            conn,
            {
              database: db,
              tables: pickedTables.map((p) => p.name),
              structure: content.structure,
              data: content.data,
              dropTables: has('drop'),
              createDatabase: has('createDb'),
              views: has('views'),
              routines: has('routines'),
              triggers: has('triggers'),
              insertBytes: 1024 * 1024,
              version,
            },
            file.fsPath,
            (p) => {
              const inc = p.tableIndex !== lastIndex ? 100 / Math.max(1, p.tableCount) : 0;
              lastIndex = p.tableIndex;
              progress.report({ message: `${p.table} (${p.tableIndex + 1}/${p.tableCount})${p.rows ? ` · ${p.rows.toLocaleString()} rows` : ''}`, increment: inc });
            },
            () => cancelled,
          );
        },
      );
      const action = await vscode.window.showInformationMessage(
        `Exported ${db}: ${res.tables} tables, ${res.rows.toLocaleString()} rows → ${path.basename(file.fsPath)}`,
        'Reveal in Folder',
      );
      if (action) {
        await vscode.commands.executeCommand('revealFileInOS', file);
      }
    } catch (e) {
      if (cancelled) {
        void vscode.window.showInformationMessage('Export cancelled.');
        return;
      }
      throw e;
    } finally {
      conn.destroy();
    }
  }

  async function importSql(n?: Node): Promise<void> {
    const t = await target(n, false);
    if (!t) {
      return;
    }
    const cfg = conns.config(t.connId);
    if (cfg.readOnly) {
      void vscode.window.showWarningMessage(`"${cfg.name}" is read-only.`);
      return;
    }
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'SQL files': ['sql', 'gz'], 'All files': ['*'] }, openLabel: 'Import' });
    if (!files?.[0]) {
      return;
    }
    const file = files[0].fsPath;
    const where = t.db ? `database "${t.db}"` : `server "${cfg.name}"`;
    const ok = await vscode.window.showWarningMessage(
      `Run ${path.basename(file)} on ${where}?`,
      { modal: true, detail: `${cfg.user}@${cfg.host}:${cfg.port}\nThe file may create, replace or delete data.` },
      'Import',
    );
    if (ok !== 'Import') {
      return;
    }
    const conn = await conns.dedicated(t.connId, t.db);
    let cancelled = false;
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Importing ${path.basename(file)}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => (cancelled = true));
          let lastPct = 0;
          return importSqlFile(
            conn,
            file,
            (p) => {
              const pct = (p.bytesRead / Math.max(1, p.totalBytes)) * 100;
              progress.report({
                message: `${p.statements.toLocaleString()} statements · ${formatBytes(p.bytesRead)} / ${formatBytes(p.totalBytes)}${p.errors ? ` · ${p.errors} errors` : ''}`,
                increment: pct - lastPct,
              });
              lastPct = pct;
            },
            async (sql, err) => {
              const choice = await vscode.window.showErrorMessage(
                `Statement failed: ${errorText(err)}`,
                { modal: true, detail: sql.length > 600 ? sql.slice(0, 600) + '…' : sql },
                'Skip',
                'Skip All Errors',
                'Stop',
              );
              return choice === 'Skip' ? 'skip' : choice === 'Skip All Errors' ? 'skipAll' : 'stop';
            },
            () => cancelled,
          );
        },
      );
      schema.invalidate(t.connId);
      tree.refresh();
      void vscode.window.showInformationMessage(
        `Import finished: ${res.statements.toLocaleString()} statements executed${res.errors ? `, ${res.errors} failed` : ''}.`,
      );
    } catch (e) {
      schema.invalidate(t.connId);
      tree.refresh();
      if (cancelled) {
        void vscode.window.showWarningMessage('Import cancelled. Statements already executed were not rolled back.');
        return;
      }
      throw e;
    } finally {
      conn.destroy();
    }
  }
}

function placeholder(dataType: string): string {
  const t = dataType.toLowerCase();
  if (/int|decimal|float|double|bit|year/.test(t)) {
    return '0';
  }
  if (t === 'date') {
    return "'2025-01-01'";
  }
  if (/datetime|timestamp/.test(t)) {
    return 'NOW()';
  }
  if (t === 'json') {
    return "'{}'";
  }
  return "''";
}
