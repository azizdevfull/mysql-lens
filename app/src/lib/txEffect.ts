/**
 * What a statement does to an open transaction in manual-commit mode, judged by
 * its first keywords:
 * - `write`: changes data inside the transaction (counted as uncommitted)
 * - `commit` / `rollback`: ends the transaction
 * - `implicit`: MySQL commits the open transaction before running it (DDL,
 *   user management, LOCK TABLES, START TRANSACTION …)
 * - `none`: reads and session settings
 */
export type TxEffect = 'write' | 'commit' | 'rollback' | 'implicit' | 'none';

const LEADING = /^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*(?!!)[\s\S]*?\*\/)*/;

export function txEffect(sql: string): TxEffect {
  const text = sql.replace(LEADING, '').replace(/^\(+\s*/, '');
  const m = /^([a-z]+)(?:\s+([a-z]+))?(?:\s+([a-z]+))?/i.exec(text);
  if (!m) return 'none';
  const [a, b, c] = [m[1], m[2] ?? '', m[3] ?? ''].map((w) => w.toLowerCase());
  switch (a) {
    case 'insert':
    case 'update':
    case 'delete':
    case 'replace':
    case 'call':
    case 'load':
    case 'handler':
      return 'write';
    case 'commit':
      return 'commit';
    case 'rollback':
      // ROLLBACK [WORK] TO [SAVEPOINT] x only undoes part of the transaction.
      return b === 'to' || c === 'to' ? 'none' : 'rollback';
    case 'begin':
    case 'start':
    case 'create':
    case 'alter':
    case 'drop':
    case 'rename':
    case 'truncate':
    case 'grant':
    case 'revoke':
    case 'lock':
    case 'install':
    case 'uninstall':
    case 'analyze':
    case 'optimize':
    case 'repair':
    case 'flush':
    case 'reset':
      return 'implicit';
    case 'set':
      // SET autocommit = 1 commits; SET PASSWORD is account management.
      return /^set\s+(?:@@(?:session\.)?|session\s+)?autocommit\s*=\s*(?:1|on|true)\b/i.test(text) || b === 'password' ? 'implicit' : 'none';
    case 'unlock':
      return b === 'tables' ? 'implicit' : 'none';
    default:
      return 'none';
  }
}

/** Uncommitted work after running statements whose results are `results` (in order). */
export function applyTxEffects(
  pending: { statements: number; rows: number },
  results: { kind: string; sql: string; affectedRows?: number }[],
): { statements: number; rows: number; ended: 'commit' | 'rollback' | 'implicit' | null; implicitBy?: string } {
  let { statements, rows } = pending;
  let ended: 'commit' | 'rollback' | 'implicit' | null = null;
  let implicitBy: string | undefined;
  for (const r of results) {
    if (r.kind === 'error') continue;
    const e = txEffect(r.sql);
    if (e === 'write') {
      statements += 1;
      rows += r.affectedRows ?? 0;
    } else if (e !== 'none') {
      if (e === 'implicit' && statements > 0) implicitBy = r.sql.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
      if (statements > 0 || e !== 'implicit') ended = e;
      statements = 0;
      rows = 0;
    }
  }
  return { statements, rows, ended, implicitBy };
}
