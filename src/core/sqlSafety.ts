/** Statements that change or remove data broadly: UPDATE/DELETE without WHERE, DROP, TRUNCATE. */
export function riskyStatements(sqls: string[]): string[] {
  return sqls.filter((s) => {
    const t = s.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*/g, ' ').trim();
    if (/^(drop|truncate)\b/i.test(t)) {
      return true;
    }
    return /^(update|delete)\b/i.test(t) && !/\bwhere\b/i.test(t);
  });
}
