//! Conversion between MySQL values and grid cells, and SQL literal quoting.

use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::Value;
use serde_json::Value as J;

use crate::types::{Cell, Column};

const BINARY_CHARSET: u16 = 63;
const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub fn is_numeric_type(t: ColumnType) -> bool {
    use ColumnType::*;
    matches!(t, MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL | MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_INT24 | MYSQL_TYPE_YEAR)
}

fn is_integer_type(t: ColumnType) -> bool {
    use ColumnType::*;
    matches!(t, MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_INT24 | MYSQL_TYPE_YEAR)
}

fn is_binary_like(c: &mysql_async::Column) -> bool {
    use ColumnType::*;
    c.character_set() == BINARY_CHARSET
        && matches!(c.column_type(), MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB | MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_STRING | MYSQL_TYPE_VARCHAR | MYSQL_TYPE_BIT | MYSQL_TYPE_GEOMETRY)
}

/// Column metadata from a result set field.
pub fn column_from_field(c: &mysql_async::Column) -> Column {
    use ColumnType::*;
    let t = c.column_type();
    let flags = c.flags();
    let binary = is_binary_like(c);
    let name = match t {
        MYSQL_TYPE_TINY => "TINYINT",
        MYSQL_TYPE_SHORT => "SMALLINT",
        MYSQL_TYPE_LONG => "INT",
        MYSQL_TYPE_INT24 => "MEDIUMINT",
        MYSQL_TYPE_LONGLONG => "BIGINT",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "DECIMAL",
        MYSQL_TYPE_FLOAT => "FLOAT",
        MYSQL_TYPE_DOUBLE => "DOUBLE",
        MYSQL_TYPE_YEAR => "YEAR",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "DATE",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "TIME",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "DATETIME",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "TIMESTAMP",
        MYSQL_TYPE_JSON => "JSON",
        MYSQL_TYPE_BIT => "BIT",
        MYSQL_TYPE_ENUM => "ENUM",
        MYSQL_TYPE_SET => "SET",
        MYSQL_TYPE_GEOMETRY => "GEOMETRY",
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            if binary {
                "BLOB"
            } else {
                "TEXT"
            }
        }
        MYSQL_TYPE_STRING => {
            if flags.contains(ColumnFlags::ENUM_FLAG) {
                "ENUM"
            } else if flags.contains(ColumnFlags::SET_FLAG) {
                "SET"
            } else if binary {
                "BINARY"
            } else {
                "CHAR"
            }
        }
        _ => {
            if binary {
                "VARBINARY"
            } else {
                "VARCHAR"
            }
        }
    };
    let table = c.org_table_str();
    Column {
        name: c.name_str().into_owned(),
        col_type: name.to_string(),
        pk: Some(flags.contains(ColumnFlags::PRI_KEY_FLAG)),
        nullable: Some(!flags.contains(ColumnFlags::NOT_NULL_FLAG)),
        auto_increment: Some(flags.contains(ColumnFlags::AUTO_INCREMENT_FLAG)),
        numeric: Some(is_numeric_type(t)),
        binary: if binary { Some(true) } else { None },
        comment: if table.is_empty() { None } else { Some(table.into_owned()) },
        ..Default::default()
    }
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

/// Standard base64 with padding (RFC 4648), for sending binary values to the UI.
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Converts a value from the text protocol to a grid cell.
pub fn to_cell(v: &Value, c: &mysql_async::Column) -> Cell {
    match v {
        Value::NULL => J::Null,
        Value::Bytes(b) => {
            if is_binary_like(c) {
                if b.len() <= 4096 {
                    J::String(hex(b))
                } else {
                    J::String(format!("(binary {} bytes)", b.len()))
                }
            } else if is_integer_type(c.column_type()) {
                let s = String::from_utf8_lossy(b);
                match s.parse::<i64>() {
                    Ok(n) if n.abs() <= MAX_SAFE => J::from(n),
                    _ => J::String(s.into_owned()),
                }
            } else {
                J::String(String::from_utf8_lossy(b).into_owned())
            }
        }
        Value::Int(n) => {
            if n.abs() <= MAX_SAFE {
                J::from(*n)
            } else {
                J::String(n.to_string())
            }
        }
        Value::UInt(n) => {
            if *n <= MAX_SAFE as u64 {
                J::from(*n)
            } else {
                J::String(n.to_string())
            }
        }
        Value::Float(f) => J::from(*f as f64),
        Value::Double(f) => J::from(*f),
        Value::Date(y, mo, d, h, mi, s, us) => {
            let base = format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}");
            J::String(if *us > 0 { format!("{base}.{us:06}") } else { base })
        }
        Value::Time(neg, d, h, mi, s, us) => {
            let hours = *d * 24 + *h as u32;
            let base = format!("{}{hours:02}:{mi:02}:{s:02}", if *neg { "-" } else { "" });
            J::String(if *us > 0 { format!("{base}.{us:06}") } else { base })
        }
    }
}

/// Quotes an identifier with backticks.
pub fn qid(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

pub fn qualified(db: &str, name: &str) -> String {
    format!("{}.{}", qid(db), qid(name))
}

/// MySQL string literal with the same escaping as mysql_real_escape_string.
pub fn quote_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        match ch {
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '"' => out.push_str("\\\""),
            '\x1a' => out.push_str("\\Z"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn is_number_text(s: &str) -> bool {
    let t = s.trim();
    let body = t.strip_prefix('-').unwrap_or(t);
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || c == '.') && body.chars().filter(|c| *c == '.').count() <= 1 && !body.starts_with('.') && !body.ends_with('.')
}

/// SQL literal for a cell coming back from the grid.
pub fn cell_literal(v: &Cell, col: Option<&Column>) -> String {
    match v {
        J::Null => "NULL".into(),
        J::Bool(b) => (if *b { "1" } else { "0" }).into(),
        J::Number(n) => n.to_string(),
        J::String(s) => {
            let binary = col.and_then(|c| c.binary).unwrap_or(false);
            if binary && s.len() >= 2 && s[..2].eq_ignore_ascii_case("0x") && s[2..].chars().all(|c| c.is_ascii_hexdigit()) {
                return if s.len() == 2 { "''".into() } else { format!("X'{}'", &s[2..]) };
            }
            if col.and_then(|c| c.numeric).unwrap_or(false) && is_number_text(s) {
                return s.trim().to_string();
            }
            quote_str(s)
        }
        other => quote_str(&other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(quote_str("it's \\ \n"), "'it\\'s \\\\ \\n'");
        assert_eq!(qid("we`ird"), "`we``ird`");
        let num = Column { numeric: Some(true), ..Default::default() };
        assert_eq!(cell_literal(&J::String("12.50".into()), Some(&num)), "12.50");
        assert_eq!(cell_literal(&J::String("1e3".into()), Some(&num)), "'1e3'");
        let bin = Column { binary: Some(true), ..Default::default() };
        assert_eq!(cell_literal(&J::String("0xABCD".into()), Some(&bin)), "X'ABCD'");
        assert_eq!(cell_literal(&J::Null, None), "NULL");
    }

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }
}
