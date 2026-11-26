import type { Connection } from './types';

/** The statement without comments and leading whitespace, for keyword checks. */
function bare(sql: string): string {
  return sql
    .replace(/\/\*!\d*([\s\S]*?)\*\//g, ' $1 ') // versioned comments run: keep their body
    .replace(/\/\*[\s\S]*?\*\/|--[ \t][^\n]*|--$|#[^\n]*/gm, ' ')
    .trim();
}

/** Statements that change or remove data broadly: UPDATE/DELETE without WHERE, DROP, TRUNCATE. */
export function riskyStatements(sqls: string[]): string[] {
  return sqls.filter((s) => {
    const t = bare(s);
    if (/^(drop|truncate)\b/i.test(t)) return true;
    return /^(update|delete)\b/i.test(t) && !/\bwhere\b/i.test(t);
  });
}

/** Leading keywords of statements that only read. Everything else counts as a write. */
const READ_ONLY = /^(select|show|explain|describe|desc|use|help|values|table|with|\()/i;

/** Statements that may change data or schema. */
export function writeStatements(sqls: string[]): string[] {
  return sqls.filter((s) => {
    const t = bare(s);
    // WITH … SELECT reads; WITH … UPDATE/DELETE (MySQL 8) writes.
    if (/^with\b/i.test(t)) return /\b(update|delete|insert|replace)\b/i.test(t);
    // SET changes the session only, except server-wide variables and passwords.
    if (/^set\b/i.test(t)) return /^set\s+(global|persist|persist_only|password)\b|^set\s+@@(global|persist)/i.test(t);
    return t.length > 0 && !READ_ONLY.test(t);
  });
}

/** A red tag marks a production server: every write there asks first. */
export function isProduction(c: Connection | undefined): boolean {
  return c?.color === 'red';
}

/** Short one-line previews for a confirmation dialog. */
export function preview(sqls: string[], max = 5): string {
  const lines = sqls.slice(0, max).map((s) => {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > 160 ? `${one.slice(0, 157)}…` : one;
  });
  if (sqls.length > max) lines.push(`…and ${sqls.length - max} more`);
  return lines.join('\n');
}
