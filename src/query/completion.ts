import * as vscode from 'vscode';
import { SchemaService } from '../schema';
import { EditorSessions } from './editorSessions';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'AS', 'DISTINCT',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'ON', 'USING', 'GROUP BY', 'ORDER BY', 'HAVING',
  'LIMIT', 'OFFSET', 'ASC', 'DESC', 'UNION', 'UNION ALL', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'REPLACE INTO', 'ON DUPLICATE KEY UPDATE', 'CREATE TABLE', 'CREATE DATABASE', 'CREATE INDEX', 'CREATE VIEW',
  'ALTER TABLE', 'ADD COLUMN', 'DROP COLUMN', 'MODIFY COLUMN', 'RENAME TO', 'DROP TABLE', 'TRUNCATE TABLE',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'INDEX', 'DEFAULT', 'AUTO_INCREMENT', 'NOT NULL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'RECURSIVE', 'EXPLAIN', 'SHOW TABLES', 'SHOW DATABASES',
  'SHOW CREATE TABLE', 'SHOW PROCESSLIST', 'DESCRIBE', 'USE', 'START TRANSACTION', 'COMMIT', 'ROLLBACK',
  'INT', 'BIGINT', 'TINYINT', 'VARCHAR', 'TEXT', 'LONGTEXT', 'DATETIME', 'TIMESTAMP', 'DATE', 'DECIMAL', 'JSON',
  'BOOLEAN', 'CURRENT_TIMESTAMP', 'ENGINE=InnoDB', 'CHARSET=utf8mb4',
];

const FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'CONCAT', 'CONCAT_WS', 'COALESCE', 'IFNULL', 'NULLIF', 'IF',
  'NOW', 'CURDATE', 'CURTIME', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'TIMESTAMPDIFF', 'UNIX_TIMESTAMP',
  'FROM_UNIXTIME', 'YEAR', 'MONTH', 'DAY', 'LOWER', 'UPPER', 'TRIM', 'SUBSTRING', 'REPLACE', 'LENGTH',
  'CHAR_LENGTH', 'ROUND', 'FLOOR', 'CEIL', 'ABS', 'CAST', 'CONVERT', 'JSON_EXTRACT', 'JSON_UNQUOTE', 'JSON_OBJECT',
  'JSON_ARRAY', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'UUID', 'MD5', 'SHA2', 'FIND_IN_SET',
];

export class SqlCompletion implements vscode.CompletionItemProvider {
  constructor(
    private readonly sessions: EditorSessions,
    private readonly schema: SchemaService,
  ) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
    const b = this.sessions.binding(doc.uri);
    const items: vscode.CompletionItem[] = [];
    const linePrefix = doc.lineAt(pos.line).text.slice(0, pos.character);
    const dotted = /([`\w$]+)\.(`?[\w$]*)$/.exec(linePrefix);

    let tables: string[] = [];
    let columns = new Map<string, string[]>();
    if (b?.database) {
      try {
        const [t, c] = await Promise.all([this.schema.tables(b.connId, b.database), this.schema.allColumns(b.connId, b.database)]);
        tables = t.map((x) => x.name);
        columns = c;
      } catch {
        // Not connected or no permission: keywords only.
      }
    }

    if (dotted) {
      const qualifier = dotted[1].replace(/`/g, '');
      const table = resolveAlias(doc.getText(), qualifier) ?? qualifier;
      const cols = columns.get(table) ?? [...columns.entries()].find(([k]) => k.toLowerCase() === table.toLowerCase())?.[1];
      if (cols) {
        return cols.map((c) => {
          const it = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
          it.detail = table;
          it.sortText = '0';
          return it;
        });
      }
      if (b) {
        try {
          const other = await this.schema.tables(b.connId, qualifier);
          return other.map((t) => new vscode.CompletionItem(t.name, vscode.CompletionItemKind.Struct));
        } catch {
          return [];
        }
      }
      return [];
    }

    for (const t of tables) {
      const it = new vscode.CompletionItem(t, vscode.CompletionItemKind.Struct);
      it.detail = 'table';
      it.sortText = '1' + t;
      items.push(it);
    }
    // Columns of tables mentioned in the current text rank first.
    const text = doc.getText();
    const mentioned = tables.filter((t) => new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(text));
    const seen = new Set<string>();
    for (const t of mentioned) {
      for (const c of columns.get(t) ?? []) {
        if (seen.has(c)) {
          continue;
        }
        seen.add(c);
        const it = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
        it.detail = t;
        it.sortText = '0' + c;
        items.push(it);
      }
    }
    for (const k of KEYWORDS) {
      const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
      it.sortText = '2' + k;
      items.push(it);
    }
    for (const f of FUNCTIONS) {
      const it = new vscode.CompletionItem(f, vscode.CompletionItemKind.Function);
      it.insertText = new vscode.SnippetString(`${f}($1)`);
      it.sortText = '3' + f;
      items.push(it);
    }
    return items;
  }
}

function resolveAlias(text: string, alias: string): string | undefined {
  const re = new RegExp(`(?:from|join|update|into)\\s+(?:\`?[\\w$]+\`?\\.)?\`?([\\w$]+)\`?\\s+(?:as\\s+)?\`?${escapeRe(alias)}\`?\\b`, 'i');
  return re.exec(text)?.[1];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
