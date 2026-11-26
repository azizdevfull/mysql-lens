import { splitSql } from './sqlsplit';

/** Routine and trigger bodies are left as written: their layout is the author's. */
const ROUTINE = /^\s*create\s+(?:or\s+replace\s+)?(?:definer\s*=\s*\S+\s+)?(?:procedure|function|trigger|event)\b/i;

/**
 * Formats each statement of `text` in place (MySQL dialect, upper-case keywords).
 * Text between statements (comments, blank lines, `DELIMITER` lines) is kept as is,
 * so scripts with custom delimiters still run the same after formatting.
 * The formatter is loaded on first use to keep startup fast.
 */
export async function formatSql(text: string): Promise<string> {
  const { format } = await import('sql-formatter');
  const statements = splitSql(text);
  let out = text;
  // From the end, so earlier offsets stay valid while replacing.
  for (const s of [...statements].reverse()) {
    const original = text.slice(s.start, s.end);
    if (ROUTINE.test(stripLeadingComments(original))) continue;
    const pretty = format(original, { language: 'mysql', keywordCase: 'upper', dataTypeCase: 'upper', functionCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 });
    out = out.slice(0, s.start) + pretty + out.slice(s.end);
  }
  return out;
}

function stripLeadingComments(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '');
}
