import type { SortSpec } from './types';

export interface TableQueryState {
  page: number;
  pageSize: number;
  sort: SortSpec | null;
  filter: string;
}

const RESERVED = /^(select|from|where|order|group|by|limit|offset|key|keys|index|table|status|desc|asc|user|range|rank|rows|row|window|function|interval|match|condition|signal|groups|lead|lag|system|virtual|check|default|values|value|read|write|change|column|columns|database|schema|primary|unique|join|left|right|on|in|is|not|and|or|like|as|set|update|delete|insert|into|create|drop|alter|use|show|case|when|then|else|end|null|true|false|int|char|varchar|date|time|timestamp|year|month|day)$/i;

/** Backticks only when the name needs them, so the query reads like hand-written SQL. */
function qid(name: string): string {
  return /^[A-Za-z_][\w$]*$/.test(name) && !RESERVED.test(name) ? name : '`' + name.replace(/`/g, '``') + '`';
}

/** The SELECT shown in the table editor for the current paging state. */
export function buildTableQuery(table: string, s: TableQueryState): string {
  let sql = `SELECT * FROM ${qid(table)}`;
  if (s.filter.trim()) {
    sql += ` WHERE ${s.filter.trim()}`;
  }
  if (s.sort) {
    sql += ` ORDER BY ${qid(s.sort.column)} ${s.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
  }
  sql += ` LIMIT ${s.pageSize}`;
  if (s.page > 0) {
    sql += ` OFFSET ${s.page * s.pageSize}`;
  }
  return sql;
}

const ident = (name: string) => `(?:\`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/`/g, '``')}\`|${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`;

/**
 * Recognises `SELECT * FROM <table> [WHERE …] [ORDER BY col [ASC|DESC]] [LIMIT n [OFFSET m]]`
 * on this panel's table. Such queries keep the grid editable and paged; anything
 * else runs as a read-only custom query.
 */
export function parseTableQuery(sql: string, db: string, table: string, defaultPageSize: number): TableQueryState | null {
  const text = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)\s*(--|#)[^\n]*/g, ' ')
    .trim()
    .replace(/;\s*$/, '')
    .trim();
  const re = new RegExp(
    String.raw`^select\s+\*\s+from\s+(?:${ident(db)}\s*\.\s*)?${ident(table)}` +
      String.raw`(?:\s+where\s+([\s\S]+?))?` +
      String.raw`(?:\s+order\s+by\s+(\`[^\`]+\`|[\w$]+)(?:\s+(asc|desc))?)?` +
      String.raw`(?:\s+limit\s+(\d+)(?:\s*,\s*(\d+)|\s+offset\s+(\d+))?)?$`,
    'i',
  );
  const m = re.exec(text);
  if (!m) {
    return null;
  }
  const [, where, orderCol, orderDir, lim1, limComma, offsetKw] = m;
  // A WHERE that swallowed GROUP BY / HAVING / UNION / JOIN is not a simple filter.
  if (where && /\b(group\s+by|having|union|join|order\s+by|limit)\b/i.test(where.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*"/g, "''"))) {
    return null;
  }
  let pageSize = defaultPageSize;
  let offset = 0;
  if (lim1 !== undefined) {
    if (limComma !== undefined) {
      offset = Number(lim1);
      pageSize = Number(limComma);
    } else {
      pageSize = Number(lim1);
      offset = offsetKw !== undefined ? Number(offsetKw) : 0;
    }
  }
  if (pageSize <= 0) {
    return null;
  }
  return {
    filter: (where ?? '').trim(),
    sort: orderCol ? { column: orderCol.replace(/^`|`$/g, '').replace(/``/g, '`'), dir: orderDir?.toLowerCase() === 'desc' ? 'desc' : 'asc' } : null,
    pageSize,
    page: Math.floor(offset / pageSize),
  };
}
