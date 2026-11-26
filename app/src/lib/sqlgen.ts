import type { Column, ResultSet } from './types';

/** Backtick-quotes an identifier. */
export const qid = (s: string) => '`' + s.replace(/`/g, '``') + '`';

export type TemplateKind = 'select' | 'insert' | 'update' | 'delete';

/** A literal that fits the column type, for the user to replace. */
function placeholder(c: Column): string {
  const t = c.type.toLowerCase();
  if (c.options?.length) return `'${c.options[0].replace(/'/g, "''")}'`;
  if (c.numeric || /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)\b/.test(t)) return '0';
  if (/^(datetime|timestamp)\b/.test(t)) return 'CURRENT_TIMESTAMP';
  if (/^date\b/.test(t)) return 'CURRENT_DATE';
  if (/^time\b/.test(t)) return 'CURRENT_TIME';
  if (/^json\b/.test(t)) return "'{}'";
  return "''";
}

/** `items` as lines joined by commas, each followed by an optional `-- comment`. */
function commented(items: { text: string; note?: string }[], indent: string): string {
  return items.map((it, i) => `${indent}${it.text}${i < items.length - 1 ? ',' : ''}${it.note ? ` -- ${it.note}` : ''}`).join('\n');
}

function keyWhere(columns: Column[]): string {
  const keys = columns.filter((c) => c.pk);
  if (!keys.length) return ' -- No primary key: write a condition that matches the rows you mean.\n WHERE 1 = 0';
  return ` WHERE ${keys.map((c) => `${qid(c.name)} = ${placeholder(c)}`).join('\n   AND ')}`;
}

/** A ready-to-edit SELECT / INSERT / UPDATE / DELETE statement for `table`. */
export function sqlTemplate(kind: TemplateKind, table: string, columns: Column[]): string {
  const t = qid(table);
  switch (kind) {
    case 'select':
      return `SELECT\n${columns.map((c) => `  ${qid(c.name)}`).join(',\n')}\n  FROM ${t}\n WHERE 1 = 1\n LIMIT 100;`;
    case 'insert': {
      const cols = columns.filter((c) => !c.autoIncrement);
      return `INSERT INTO ${t} (\n${cols.map((c) => `  ${qid(c.name)}`).join(',\n')}\n) VALUES (\n${commented(cols.map((c) => ({ text: placeholder(c), note: `${c.name} ${c.type}` })), '  ')}\n);`;
    }
    case 'update': {
      const nonKey = columns.filter((c) => !c.pk);
      const cols = nonKey.length ? nonKey : columns;
      const set = commented(cols.map((c) => ({ text: `${qid(c.name)} = ${placeholder(c)}`, note: c.type })), '       ').trimStart();
      return `UPDATE ${t}\n   SET ${set}\n${keyWhere(columns)}\n LIMIT 1;`;
    }
    case 'delete':
      return `DELETE FROM ${t}\n${keyWhere(columns)}\n LIMIT 1;`;
  }
}

/** The CREATE statement in the result of SHOW CREATE TABLE / VIEW / PROCEDURE / FUNCTION / TRIGGER. */
export function ddlFromResult(results: ResultSet[]): string | null {
  const r = results.find((x) => x.kind === 'rows' && x.rows.length);
  if (!r) return null;
  const i = r.columns.findIndex((c) => /^create /i.test(c.name) || c.name === 'SQL Original Statement');
  const v = i >= 0 ? r.rows[0][i] : null;
  return typeof v === 'string' && v.trim() ? v : null;
}
