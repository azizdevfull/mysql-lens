//! Incremental SQL statement splitter (quotes, comments, DELIMITER), ported from the TypeScript version.

#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Normal,
    Single,
    Double,
    Backtick,
    Line,
    Block,
}

pub struct SqlSplitter {
    buf: Vec<char>,
    base: usize,
    pos: usize,
    stmt_start: usize,
    state: State,
    delimiter: Vec<char>,
    at_line_start: bool,
}

impl Default for SqlSplitter {
    fn default() -> Self {
        Self { buf: Vec::new(), base: 0, pos: 0, stmt_start: 0, state: State::Normal, delimiter: vec![';'], at_line_start: true }
    }
}

fn only_comments(text: &[char]) -> bool {
    let n = text.len();
    let mut i = 0;
    while i < n {
        let c = text[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '#' || (c == '-' && i + 1 < n && text[i + 1] == '-' && (i + 2 >= n || text[i + 2].is_whitespace())) {
            while i < n && text[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < n && text[i + 1] == '*' && !(i + 2 < n && text[i + 2] == '!') {
            i += 2;
            while i + 1 < n && !(text[i] == '*' && text[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else {
            return false;
        }
    }
    true
}

impl SqlSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    fn make(&self, from: usize, to: usize) -> Statement {
        let raw: String = self.buf[from..to].iter().collect();
        let lead = raw.chars().take_while(|c| c.is_whitespace()).count();
        let sql = raw.trim().to_string();
        let len = sql.chars().count();
        Statement { sql, start: self.base + from + lead, end: self.base + from + lead + len }
    }

    fn starts_with(&self, i: usize, pat: &[char]) -> bool {
        i + pat.len() <= self.buf.len() && self.buf[i..i + pat.len()] == *pat
    }

    pub fn push(&mut self, chunk: &str) -> Vec<Statement> {
        self.buf.extend(chunk.chars());
        self.scan(false)
    }

    pub fn end(&mut self) -> Vec<Statement> {
        let mut out = self.scan(true);
        let rest = &self.buf[self.stmt_start..];
        if rest.iter().any(|c| !c.is_whitespace()) && !only_comments(rest) {
            out.push(self.make(self.stmt_start, self.buf.len()));
        }
        let n = self.buf.len();
        self.compact(n);
        out
    }

    fn compact(&mut self, up_to: usize) {
        self.buf.drain(..up_to);
        self.base += up_to;
        self.pos -= up_to.min(self.pos);
        self.stmt_start -= up_to.min(self.stmt_start);
    }

    fn scan(&mut self, final_pass: bool) -> Vec<Statement> {
        let mut out = Vec::new();
        let n = self.buf.len();
        let guard = if final_pass { n } else { n.saturating_sub(10.max(self.delimiter.len() + 1)) };
        let mut i = self.pos;
        while i < guard {
            let c = self.buf[i];
            match self.state {
                State::Single | State::Double | State::Backtick => {
                    let q = match self.state {
                        State::Single => '\'',
                        State::Double => '"',
                        _ => '`',
                    };
                    if c == '\\' && self.state != State::Backtick {
                        i += 2;
                        continue;
                    }
                    if c == q {
                        if i + 1 < n && self.buf[i + 1] == q {
                            i += 2;
                            continue;
                        }
                        self.state = State::Normal;
                    }
                    i += 1;
                    continue;
                }
                State::Line => {
                    if c == '\n' {
                        self.state = State::Normal;
                        self.at_line_start = true;
                    }
                    i += 1;
                    continue;
                }
                State::Block => {
                    if c == '*' && i + 1 < n && self.buf[i + 1] == '/' {
                        self.state = State::Normal;
                        i += 2;
                        continue;
                    }
                    i += 1;
                    continue;
                }
                State::Normal => {}
            }
            if self.at_line_start && (c == 'D' || c == 'd') && i + 10 <= n {
                let word: String = self.buf[i..i + 10].iter().collect();
                if word[..9].eq_ignore_ascii_case("delimiter") && (word.ends_with(' ') || word.ends_with('\t')) {
                    let nl = self.buf[i..].iter().position(|&x| x == '\n').map(|p| p + i);
                    if nl.is_none() && !final_pass {
                        break;
                    }
                    let line_end = nl.unwrap_or(n);
                    let pending = &self.buf[self.stmt_start..i];
                    if pending.iter().any(|c| !c.is_whitespace()) && !only_comments(pending) {
                        out.push(self.make(self.stmt_start, i));
                    }
                    let d: String = self.buf[i + 10..line_end].iter().collect();
                    let d = d.trim();
                    if !d.is_empty() {
                        self.delimiter = d.chars().collect();
                    }
                    i = (line_end + 1).min(n);
                    self.stmt_start = i;
                    self.at_line_start = true;
                    continue;
                }
            }
            if c == '\n' {
                self.at_line_start = true;
                i += 1;
                continue;
            }
            if c == ' ' || c == '\t' || c == '\r' {
                i += 1;
                continue;
            }
            self.at_line_start = false;
            if c == '\'' {
                self.state = State::Single;
            } else if c == '"' {
                self.state = State::Double;
            } else if c == '`' {
                self.state = State::Backtick;
            } else if c == '#' {
                self.state = State::Line;
            } else if c == '-' && i + 1 < n && self.buf[i + 1] == '-' && (i + 2 >= n || self.buf[i + 2].is_whitespace()) {
                self.state = State::Line;
            } else if c == '/' && i + 1 < n && self.buf[i + 1] == '*' {
                self.state = State::Block;
                i += 2;
                continue;
            } else if self.starts_with(i, &self.delimiter.clone()) {
                let piece = &self.buf[self.stmt_start..i];
                if piece.iter().any(|c| !c.is_whitespace()) && !only_comments(piece) {
                    out.push(self.make(self.stmt_start, i));
                }
                i += self.delimiter.len();
                self.stmt_start = i;
                continue;
            }
            i += 1;
        }
        self.pos = i.min(n);
        if self.stmt_start > 65536 {
            let s = self.stmt_start;
            self.compact(s);
        }
        out
    }
}

pub fn split_sql(text: &str) -> Vec<Statement> {
    let mut s = SqlSplitter::new();
    let mut out = s.push(text);
    out.extend(s.end());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits() {
        let sql = "SELECT 'a;b' AS x; -- c;omment\nSELECT \"q\\\";\" , `we;ird` FROM t; # hash; c\n/* block ; */ SELECT 1;\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 'it''s';\nSELECT 3";
        let st: Vec<String> = split_sql(sql).into_iter().map(|s| s.sql).collect();
        assert_eq!(st.len(), 6, "{st:?}");
        assert_eq!(st[0], "SELECT 'a;b' AS x");
        assert_eq!(st[3], "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END");
        assert_eq!(st[4], "SELECT 'it''s'");
        assert_eq!(st[5], "SELECT 3");
    }

    #[test]
    fn chunked_equals_whole() {
        let sql = "INSERT INTO t VALUES ('x;y'),(\"z\");\nDELIMITER //\nCREATE TRIGGER a BEFORE INSERT ON t FOR EACH ROW BEGIN SET @a = 1; END//\nDELIMITER ;\nSELECT 1; SELECT 'ü😀;';";
        let whole: Vec<String> = split_sql(sql).into_iter().map(|s| s.sql).collect();
        for size in [1usize, 3, 7, 64] {
            let mut sp = SqlSplitter::new();
            let chars: Vec<char> = sql.chars().collect();
            let mut out = Vec::new();
            for chunk in chars.chunks(size) {
                out.extend(sp.push(&chunk.iter().collect::<String>()).into_iter().map(|s| s.sql));
            }
            out.extend(sp.end().into_iter().map(|s| s.sql));
            assert_eq!(out, whole, "chunk {size}");
        }
    }
}
