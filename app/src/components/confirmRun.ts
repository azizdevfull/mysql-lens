import type { Connection } from '@/lib/types';
import { isProduction, preview, riskyStatements, writeStatements } from '@/lib/sqlSafety';
import { ask } from '@/components/AskDialog';

/**
 * Asks before running statements that are hard to undo. Resolves true to run.
 *
 * - Anywhere: UPDATE/DELETE without WHERE, DROP and TRUNCATE ask first.
 * - On a red-tagged (production) connection: every write asks; a risky one
 *   needs the connection name typed.
 * - Read-only connections never ask: the server refuses writes anyway.
 */
export async function confirmRun(conn: Connection | undefined, sqls: string[]): Promise<boolean> {
  if (!conn || conn.readOnly) return true;
  const risky = riskyStatements(sqls);
  const prod = isProduction(conn);
  const writes = prod ? writeStatements(sqls) : [];
  if (!risky.length && !writes.length) return true;
  if (prod) {
    const answer = await ask({
      title: `Run on production "${conn.name}"?`,
      description: risky.length
        ? 'This changes or deletes data broadly and cannot be undone. Type the connection name to confirm.'
        : 'This connection is tagged red (production). These statements change data or schema:',
      detail: preview(risky.length ? risky : writes),
      confirm: 'Run on production',
      danger: true,
      input: risky.length ? { placeholder: conn.name, mustEqual: conn.name } : undefined,
    });
    return answer !== null;
  }
  const answer = await ask({ title: 'Run this anyway?', description: 'This changes or deletes data broadly and cannot be undone.', detail: preview(risky), confirm: 'Run anyway', danger: true });
  return answer !== null;
}
