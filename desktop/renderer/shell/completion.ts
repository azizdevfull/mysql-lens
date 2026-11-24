import type * as Monaco from 'monaco-editor';
import type { SchemaInfo } from '../../../src/shared/protocol';

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
  'BOOLEAN', 'CURRENT_TIMESTAMP',
];

const FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'CONCAT', 'CONCAT_WS', 'COALESCE', 'IFNULL', 'NULLIF', 'IF',
  'NOW', 'CURDATE', 'CURTIME', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'TIMESTAMPDIFF', 'UNIX_TIMESTAMP',
  'FROM_UNIXTIME', 'YEAR', 'MONTH', 'DAY', 'LOWER', 'UPPER', 'TRIM', 'SUBSTRING', 'REPLACE', 'LENGTH',
  'CHAR_LENGTH', 'ROUND', 'FLOOR', 'CEIL', 'ABS', 'CAST', 'CONVERT', 'JSON_EXTRACT', 'JSON_UNQUOTE', 'JSON_OBJECT',
  'JSON_ARRAY', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'UUID', 'MD5', 'SHA2', 'FIND_IN_SET',
];

const TABLE_CONTEXT = /\b(from|join|into|update|table|describe|truncate)\s+[\w$`]*$/i;

function quote(name: string): string {
  return /^[A-Za-z_][\w$]*$/.test(name) ? name : '`' + name.replace(/`/g, '``') + '`';
}

/** Tables mentioned in the text, plus their aliases (lowercase key -> table). */
function referenced(text: string, tables: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const find = (n: string) => tables.find((t) => t.toLowerCase() === n.toLowerCase());
  const re = /\b(?:from|join|update|into)\s+(?:`?[\w$]+`?\s*\.\s*)?`?([\w$]+)`?(?:\s+(?:as\s+)?`?([\w$]+)`?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = find(m[1]);
    if (!t) continue;
    out.set(t.toLowerCase(), t);
    if (m[2] && !KEYWORDS.includes(m[2].toUpperCase())) out.set(m[2].toLowerCase(), t);
  }
  return out;
}

export function registerSqlCompletion(
  monaco: typeof Monaco,
  schemaFor: (model: Monaco.editor.ITextModel) => Promise<SchemaInfo | null>,
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const textBefore = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const K = monaco.languages.CompletionItemKind;
      const schema = await schemaFor(model);
      const tables = schema?.tables ?? [];
      const columnsOf = (t: string) => schema?.columns[t] ?? schema?.columns[tables.find((x) => x.toLowerCase() === t.toLowerCase()) ?? ''] ?? [];
      const refs = referenced(model.getValue(), tables);

      const dotted = /(`[^`]+`|[\w$]+)\.`?[\w$]*$/.exec(lineBefore);
      if (dotted) {
        const q = dotted[1].replace(/`/g, '');
        const table = refs.get(q.toLowerCase()) ?? tables.find((t) => t.toLowerCase() === q.toLowerCase());
        if (!table) return { suggestions: [] };
        return {
          suggestions: columnsOf(table).map((c, i) => ({
            label: { label: c.name, description: c.type },
            kind: K.Field,
            insertText: quote(c.name),
            detail: `${table}.${c.name} ${c.type}${c.pk ? ' · primary key' : ''}`,
            sortText: String(i).padStart(4, '0'),
            range,
          })),
        };
      }

      const suggestions: Monaco.languages.CompletionItem[] = [];
      const wantsTable = TABLE_CONTEXT.test(textBefore);
      for (const t of tables) {
        suggestions.push({ label: { label: t, description: 'table' }, kind: K.Struct, insertText: quote(t), detail: 'table', sortText: (wantsTable ? '0' : '2') + t, range });
      }
      if (!wantsTable) {
        const inScope = refs.size ? [...new Set(refs.values())] : [];
        const seen = new Set<string>();
        for (const t of inScope) {
          for (const c of columnsOf(t)) {
            if (seen.has(c.name)) continue;
            seen.add(c.name);
            suggestions.push({
              label: { label: c.name, description: `${c.type}${inScope.length > 1 ? ' · ' + t : ''}` },
              kind: K.Field,
              insertText: quote(c.name),
              detail: `${t}.${c.name} ${c.type}`,
              sortText: '1' + c.name,
              range,
            });
          }
        }
        for (const k of KEYWORDS) suggestions.push({ label: k, kind: K.Keyword, insertText: k, sortText: '3' + k, range });
        for (const f of FUNCTIONS) {
          suggestions.push({
            label: f,
            kind: K.Function,
            insertText: `${f}($0)`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            sortText: '4' + f,
            range,
          });
        }
      }
      return { suggestions };
    },
  });
}
