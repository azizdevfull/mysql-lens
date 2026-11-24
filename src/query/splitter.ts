/**
 * Incremental SQL statement splitter.
 *
 * Understands quotes ('', "", ``), backslash escapes, `--` / `#` / C-style
 * comments and the mysql client `DELIMITER` command. Feed text with `push`
 * (chunks may split anywhere) and call `end` once at the end.
 */
export interface Statement {
  sql: string;
  /** Offset of the first character of the statement in the whole input. */
  start: number;
  /** Offset just past the statement (excluding the delimiter). */
  end: number;
}

type State = 'normal' | 'single' | 'double' | 'backtick' | 'line' | 'block';

export class SqlSplitter {
  private buf = '';
  /** Absolute offset of buf[0]. */
  private base = 0;
  /** Scan position inside buf. */
  private pos = 0;
  /** Start of the current statement inside buf. */
  private stmtStart = 0;
  private state: State = 'normal';
  private delimiter = ';';
  private atLineStart = true;

  push(chunk: string): Statement[] {
    this.buf += chunk;
    return this.scan(false);
  }

  end(): Statement[] {
    const out = this.scan(true);
    const rest = this.buf.slice(this.stmtStart);
    if (rest.trim() && !isOnlyComments(rest)) {
      out.push(this.make(this.stmtStart, this.buf.length));
    }
    this.compact(this.buf.length);
    return out;
  }

  private make(from: number, to: number): Statement {
    const raw = this.buf.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const sql = raw.trim();
    return { sql, start: this.base + from + lead, end: this.base + from + lead + sql.length };
  }

  private compact(upTo: number): void {
    this.buf = this.buf.slice(upTo);
    this.base += upTo;
    this.pos -= upTo;
    this.stmtStart -= upTo;
  }

  private scan(final: boolean): Statement[] {
    const out: Statement[] = [];
    const b = this.buf;
    const n = b.length;
    // Keep a few characters unread unless this is the final pass, so that
    // multi-character tokens (delimiters, `--`, `*/`, DELIMITER) are never cut.
    const guard = final ? n : n - Math.max(10, this.delimiter.length + 1);
    let i = this.pos;
    while (i < guard) {
      const c = b[i];
      switch (this.state) {
        case 'single':
        case 'double':
        case 'backtick': {
          const q = this.state === 'single' ? "'" : this.state === 'double' ? '"' : '`';
          if (c === '\\' && this.state !== 'backtick') {
            i += 2;
            continue;
          }
          if (c === q) {
            if (b[i + 1] === q) {
              i += 2;
              continue;
            }
            this.state = 'normal';
          }
          i++;
          continue;
        }
        case 'line':
          if (c === '\n') {
            this.state = 'normal';
            this.atLineStart = true;
          }
          i++;
          continue;
        case 'block':
          if (c === '*' && b[i + 1] === '/') {
            this.state = 'normal';
            i += 2;
            continue;
          }
          i++;
          continue;
      }

      // normal state
      if (this.atLineStart && (c === 'D' || c === 'd') && /^delimiter[ \t]/i.test(b.slice(i, i + 10))) {
        const nl = b.indexOf('\n', i);
        if (nl < 0 && !final) {
          break; // wait for the rest of the line
        }
        const lineEnd = nl < 0 ? n : nl;
        const pending = b.slice(this.stmtStart, i);
        if (pending.trim() && !isOnlyComments(pending)) {
          out.push(this.make(this.stmtStart, i));
        }
        const d = b.slice(i + 10, lineEnd).trim();
        if (d) {
          this.delimiter = d;
        }
        i = lineEnd + 1;
        this.stmtStart = i;
        this.atLineStart = true;
        continue;
      }
      if (c === '\n') {
        this.atLineStart = true;
        i++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        i++;
        continue;
      }
      this.atLineStart = false;

      if (c === "'") {
        this.state = 'single';
      } else if (c === '"') {
        this.state = 'double';
      } else if (c === '`') {
        this.state = 'backtick';
      } else if (c === '#') {
        this.state = 'line';
      } else if (c === '-' && b[i + 1] === '-' && (i + 2 >= n || /\s/.test(b[i + 2]))) {
        this.state = 'line';
      } else if (c === '/' && b[i + 1] === '*') {
        this.state = 'block';
        i += 2;
        continue;
      } else if (b.startsWith(this.delimiter, i)) {
        const piece = b.slice(this.stmtStart, i);
        if (piece.trim() && !isOnlyComments(piece)) {
          out.push(this.make(this.stmtStart, i));
        }
        i += this.delimiter.length;
        this.stmtStart = i;
        continue;
      }
      i++;
    }
    this.pos = i;
    // Drop consumed text so memory stays bounded for huge files.
    if (this.stmtStart > 65536) {
      this.compact(this.stmtStart);
    }
    return out;
  }
}

/** True when the text contains nothing but whitespace and comments. */
export function isOnlyComments(text: string): boolean {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '#' || (c === '-' && text[i + 1] === '-' && (i + 2 >= n || /\s/.test(text[i + 2])))) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
    } else if (c === '/' && text[i + 1] === '*' && text[i + 2] !== '!') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else {
      return false;
    }
  }
  return true;
}

export function splitSql(text: string): Statement[] {
  const s = new SqlSplitter();
  return [...s.push(text), ...s.end()];
}

/** Finds the statement under the cursor (or the closest one before it). */
export function statementAt(text: string, offset: number): Statement | undefined {
  const all = splitSql(text);
  let best: Statement | undefined;
  for (const st of all) {
    if (offset >= st.start && offset <= st.end + 1) {
      return st;
    }
    if (st.end < offset) {
      best = st;
    }
  }
  return best ?? all[0];
}
