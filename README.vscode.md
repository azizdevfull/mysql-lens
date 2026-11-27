# MySQL Lens

A MySQL and MariaDB client for VS Code with **unlimited connections**, SSH tunnels, an editable data grid, SQL autocomplete, and import/export for CSV, Excel, JSON and SQL dumps. Free and open source.

Also available as a fast standalone **Windows app** with an ER diagram, foreign key navigation and AI access (MCP): [lens.azizdevfull.uz](https://lens.azizdevfull.uz).

![Table editor with SQL autocomplete](media/screenshots/autocomplete.png)

## Installation

Search for **MySQL Lens** in the Extensions view, or run:

```bash
code --install-extension azizdevfull.mysql-lens
```

## Features

### Connections
- Unlimited connections to MySQL 5.7+, 8.x, 9.x and MariaDB.
- SSH tunnels with a password, a private key or ssh-agent. If the chosen key is rejected, the default `~/.ssh` keys are tried, like `ssh` does.
- SSL/TLS with an optional CA, client certificate and key.
- Read-only mode, which starts every session with `SET SESSION TRANSACTION READ ONLY`.
- A color tag for each connection, for example red for production.
- Passwords are stored in the OS keychain through VS Code Secret Storage.
- Paste a `mysql://user:pass@host:3306/db` URL to fill in the form.

![Connection form](media/screenshots/connection.png)

### Table editor
- A query box at the top with syntax highlighting and autocomplete for columns (with types), tables, aliases (`u.` lists the columns of `users u`), keywords and functions.
- `SELECT * FROM table WHERE … ORDER BY … LIMIT …` keeps the grid editable and paged. Any other query (JOINs, aggregates) shows a read-only result.
- Inline editing, adding, duplicating and deleting rows, setting NULL, and pasting from Excel. Before saving, the SQL is shown for review, and all changes are saved in one transaction.
- Filter by a cell value, server-side sorting, and paging.

![Editing rows](media/screenshots/table-editor.png)

### SQL editor
- In any `.sql` file, `Ctrl+Enter` runs the statement at the cursor (or the selection) and `Ctrl+Shift+Enter` runs all statements.
- Each editor has its own session, so `USE`, `SET` and transactions carry over between runs.
- The connection and database for the editor are chosen from the status bar.
- The results grid is virtualized, so large results stay fast. It supports multiple result sets, search, a Sum/Avg summary of the selection, and copying as TSV, CSV, JSON, SQL INSERT, Markdown or an `IN (…)` list.
- Cancel a running query (`KILL QUERY`).
- You are asked to confirm before `UPDATE`/`DELETE` without `WHERE`, `DROP` and `TRUNCATE`.

![Query results](media/screenshots/results.png)

### Import and export
- **Export** a table or a query result to CSV, TSV, Excel (.xlsx), JSON, SQL INSERT or Markdown. Rows are streamed, so large tables work.
- **Dump** a database to `.sql` or `.sql.gz`: structure and/or data, views, procedures, functions and triggers, without `DEFINER` clauses.
- **Run SQL files** (`.sql` or `.sql.gz`) as a stream, with `DELIMITER` support. When a statement fails, choose Skip, Skip All or Stop.
- **Import CSV, TSV, JSON/JSON Lines or Excel** into an existing table (columns are matched automatically) or into a new table (column types are detected). Choose INSERT, INSERT IGNORE or REPLACE. The import runs in a single transaction.

![Import wizard](media/screenshots/import.png)

### Also
- Query history.
- Export and import of the connection list (passwords are never exported).
- Generate SELECT, INSERT and UPDATE templates; show DDL; create and drop databases; truncate and drop tables.

## Keyboard shortcuts

| Where | Keys | Action |
|---|---|---|
| SQL file | `Ctrl+Enter` | Run statement at cursor / selection |
| SQL file | `Ctrl+Shift+Enter` | Run all statements |
| Query box | `Ctrl+Enter` / `Ctrl+Space` | Run / show suggestions |
| Grid | `Enter`, `F2` or typing | Edit cell |
| Grid | `Ctrl+0` | Set NULL while editing |
| Grid | `Delete` | Delete the selected rows |
| Grid | `Ctrl+C` / `Ctrl+Shift+C` | Copy / copy with headers |
| Table | `Ctrl+S`, `F5`, `Ctrl+L` | Save, reload, focus the query box |

## Settings

| Setting | Default | Description |
|---|---|---|
| `mysqlLens.maxRows` | 5000 | Rows kept in the result grid for one query |
| `mysqlLens.pageSize` | 200 | Rows per page in the table editor |
| `mysqlLens.showSystemDatabases` | false | Show `mysql`, `sys` and the schema databases |
| `mysqlLens.confirmDangerousQueries` | true | Confirm risky statements |
| `mysqlLens.historySize` | 500 | Queries kept in the history |

## Development

```bash
npm install
npm run watch        # then press F5 in VS Code
npm run typecheck
npm run test:unit
npm test             # integration tests; needs a MySQL server (MSTUDIO_* env vars)
npm run package      # builds the .vsix
```

## Privacy

MySQL Lens does not collect or send any data. It connects only to the MySQL/MariaDB servers and SSH hosts you configure. Passwords are stored in the OS keychain through VS Code Secret Storage.

## License

MIT
