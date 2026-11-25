//! mysqldump-compatible SQL dump and streaming SQL file import.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use mysql_async::prelude::*;
use mysql_async::{Conn, Row, Value};
use serde::{Deserialize, Serialize};

use crate::error::{msg, Result};
use crate::splitter::SqlSplitter;
use crate::value::{qid, qualified, quote_str};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpOptions {
    pub database: String,
    pub tables: Vec<String>,
    pub structure: bool,
    pub data: bool,
    pub drop_objects: bool,
    pub create_database: bool,
    pub views: bool,
    pub routines: bool,
    pub triggers: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpResult {
    pub tables: u64,
    pub rows: u64,
}

fn out(path: &Path) -> Result<Box<dyn Write + Send>> {
    let f = BufWriter::with_capacity(512 * 1024, File::create(path)?);
    Ok(if path.extension().map(|e| e == "gz").unwrap_or(false) { Box::new(GzEncoder::new(f, Compression::default())) } else { Box::new(f) })
}

fn strip_definer(sql: &str) -> String {
    // DEFINER=`user`@`host` (backticks, quotes or bare words)
    let lower = sql.to_ascii_lowercase();
    if let Some(i) = lower.find(" definer") {
        let rest = &sql[i + 1..];
        if let Some(eq) = rest.find('=') {
            let after = &rest[eq + 1..];
            let mut j = 0;
            let mut at_seen = false;
            let b = after.as_bytes();
            while j < b.len() {
                let c = b[j] as char;
                if c == '`' || c == '\'' || c == '"' {
                    let close = after[j + 1..].find(c).map(|k| j + 1 + k).unwrap_or(b.len() - 1);
                    j = close + 1;
                } else if c == '@' && !at_seen {
                    at_seen = true;
                    j += 1;
                } else if c.is_whitespace() {
                    if at_seen {
                        break;
                    }
                    j += 1;
                } else {
                    j += 1;
                }
            }
            return format!("{}{}", &sql[..i], &after[j..]);
        }
    }
    sql.to_string()
}

fn literal(v: &Value, numeric: bool) -> String {
    match v {
        Value::NULL => "NULL".into(),
        Value::Bytes(b) => {
            if numeric {
                String::from_utf8_lossy(b).into_owned()
            } else {
                match std::str::from_utf8(b) {
                    Ok(s) => quote_str(s),
                    Err(_) => {
                        if b.is_empty() {
                            "''".into()
                        } else {
                            let mut h = String::from("0x");
                            for x in b.iter() {
                                h.push_str(&format!("{x:02x}"));
                            }
                            h
                        }
                    }
                }
            }
        }
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(f) => f.to_string(),
        other => quote_str(&other.as_sql(true).trim_matches('\'').to_string()),
    }
}

fn s(r: &Row, i: usize) -> String {
    match r.as_ref(i) {
        Some(Value::Bytes(b)) => String::from_utf8_lossy(b).into_owned(),
        _ => String::new(),
    }
}

/// Writes a dump. `progress(table, index, count, rows)`; returning false cancels.
pub async fn dump(conn: &mut Conn, o: &DumpOptions, path: &Path, mut progress: impl FnMut(&str, usize, usize, u64) -> bool) -> Result<DumpResult> {
    let r = dump_inner(conn, o, path, &mut progress).await;
    if r.is_err() {
        let _ = std::fs::remove_file(path);
    }
    r
}

async fn dump_inner(conn: &mut Conn, o: &DumpOptions, path: &Path, progress: &mut impl FnMut(&str, usize, usize, u64) -> bool) -> Result<DumpResult> {
    conn.query_drop("SET SESSION time_zone = '+00:00'").await?;
    let version: Option<String> = conn.query_first("SELECT VERSION()").await?;
    let mut w = out(path)?;
    writeln!(w, "-- MySQL Lens dump\n-- Server version: {}\n-- Database: {}\n", version.unwrap_or_default(), o.database)?;
    w.write_all(
        b"/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n/*!40101 SET NAMES utf8mb4 */;\n/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;\n/*!40103 SET TIME_ZONE='+00:00' */;\n/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\n",
    )?;
    if o.create_database {
        let row: Option<Row> = conn.query_first(format!("SHOW CREATE DATABASE {}", qid(&o.database))).await?;
        let create = row.map(|r| s(&r, 1)).unwrap_or_else(|| format!("CREATE DATABASE {}", qid(&o.database)));
        writeln!(w, "{};\nUSE {};\n", create.replacen("CREATE DATABASE ", "CREATE DATABASE /*!32312 IF NOT EXISTS*/ ", 1), qid(&o.database))?;
    }
    let kinds: Vec<(String, String)> = conn.exec("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", (&o.database,)).await?;
    let is_view = |t: &str| kinds.iter().any(|(n, k)| n == t && k.contains("VIEW"));
    let tables: Vec<&String> = o.tables.iter().filter(|t| !is_view(t)).collect();
    let mut total = 0u64;
    for (i, t) in tables.iter().enumerate() {
        if !progress(t, i, tables.len(), 0) {
            return Err(msg("Export cancelled."));
        }
        if o.structure {
            let row: Option<Row> = conn.query_first(format!("SHOW CREATE TABLE {}", qualified(&o.database, t))).await?;
            writeln!(w, "--\n-- Table {}\n--\n", qid(t))?;
            if o.drop_objects {
                writeln!(w, "DROP TABLE IF EXISTS {};", qid(t))?;
            }
            writeln!(w, "{};\n", row.map(|r| s(&r, 1)).unwrap_or_default())?;
        }
        if o.data {
            let cols: Vec<(String, String, String)> = conn
                .exec("SELECT COLUMN_NAME, DATA_TYPE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", (&o.database, t))
                .await?;
            let real: Vec<&(String, String, String)> = cols.iter().filter(|c| !c.2.contains("GENERATED")).collect();
            if real.is_empty() {
                continue;
            }
            let numeric: Vec<bool> = real.iter().map(|c| matches!(c.1.as_str(), "tinyint" | "smallint" | "mediumint" | "int" | "bigint" | "decimal" | "float" | "double" | "year")).collect();
            let list = real.iter().map(|c| qid(&c.0)).collect::<Vec<_>>().join(", ");
            let head = format!("INSERT INTO {} ({list}) VALUES ", qid(t));
            writeln!(w, "/*!40000 ALTER TABLE {} DISABLE KEYS */;", qid(t))?;
            let mut result = conn.query_iter(format!("SELECT {list} FROM {}", qualified(&o.database, t))).await?;
            let mut batch = String::new();
            let mut rows = 0u64;
            while let Some(row) = result.next().await? {
                let tuple = format!("({})", (0..real.len()).map(|i| literal(row.as_ref(i).unwrap_or(&Value::NULL), numeric[i])).collect::<Vec<_>>().join(","));
                if !batch.is_empty() {
                    batch.push(',');
                }
                batch.push_str(&tuple);
                rows += 1;
                if batch.len() > 1_000_000 {
                    writeln!(w, "{head}{batch};")?;
                    batch.clear();
                }
                if rows % 5000 == 0 && !progress(t, i, tables.len(), rows) {
                    return Err(msg("Export cancelled."));
                }
            }
            drop(result);
            if !batch.is_empty() {
                writeln!(w, "{head}{batch};")?;
            }
            writeln!(w, "/*!40000 ALTER TABLE {} ENABLE KEYS */;\n", qid(t))?;
            total += rows;
        }
    }
    if o.views {
        for v in o.tables.iter().filter(|t| is_view(t)) {
            let row: Option<Row> = conn.query_first(format!("SHOW CREATE VIEW {}", qualified(&o.database, v))).await?;
            if o.drop_objects {
                writeln!(w, "DROP VIEW IF EXISTS {};", qid(v))?;
            }
            writeln!(w, "{};\n", strip_definer(&row.map(|r| s(&r, 1)).unwrap_or_default()))?;
        }
    }
    if o.routines {
        let routines: Vec<(String, String)> = conn.exec("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME", (&o.database,)).await?;
        for (name, kind) in routines {
            let row: Option<Row> = conn.query_first(format!("SHOW CREATE {kind} {}", qualified(&o.database, &name))).await?;
            let body = row.map(|r| s(&r, 2)).unwrap_or_default();
            if body.is_empty() {
                writeln!(w, "-- Skipped {} {}: no permission to read its body\n", kind.to_lowercase(), qid(&name))?;
                continue;
            }
            if o.drop_objects {
                writeln!(w, "DROP {kind} IF EXISTS {};", qid(&name))?;
            }
            writeln!(w, "DELIMITER ;;\n{} ;;\nDELIMITER ;\n", strip_definer(&body))?;
        }
    }
    if o.triggers {
        let triggers: Vec<(String, String)> = conn.exec("SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME", (&o.database,)).await?;
        for (name, _) in triggers.into_iter().filter(|(_, t)| o.tables.contains(t)) {
            let row: Option<Row> = conn.query_first(format!("SHOW CREATE TRIGGER {}", qualified(&o.database, &name))).await?;
            if o.drop_objects {
                writeln!(w, "DROP TRIGGER IF EXISTS {};", qid(&name))?;
            }
            writeln!(w, "DELIMITER ;;\n{} ;;\nDELIMITER ;\n", strip_definer(&row.map(|r| s(&r, 2)).unwrap_or_default()))?;
        }
    }
    w.write_all(
        b"/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n-- Dump completed\n",
    )?;
    w.flush()?;
    drop(w);
    Ok(DumpResult { tables: tables.len() as u64, rows: total })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub statements: u64,
    pub errors: Vec<String>,
}

/// Runs a .sql / .sql.gz file statement by statement on one connection.
/// With `continue_on_error`, failures are collected instead of stopping.
/// `progress(bytes_read, total_bytes, statements)`; returning false cancels.
pub async fn import_sql(conn: &mut Conn, path: &Path, continue_on_error: bool, mut progress: impl FnMut(u64, u64, u64) -> bool) -> Result<ImportResult> {
    let total = std::fs::metadata(path)?.len();
    let file = File::open(path)?;
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    struct Counting<R> {
        inner: R,
        n: std::sync::Arc<std::sync::atomic::AtomicU64>,
    }
    impl<R: Read> Read for Counting<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let k = self.inner.read(buf)?;
            self.n.fetch_add(k as u64, std::sync::atomic::Ordering::Relaxed);
            Ok(k)
        }
    }
    let counted = Counting { inner: file, n: counter.clone() };
    let mut reader: Box<dyn Read + Send> = if path.extension().map(|e| e == "gz").unwrap_or(false) { Box::new(GzDecoder::new(BufReader::new(counted))) } else { Box::new(BufReader::new(counted)) };
    let mut splitter = SqlSplitter::new();
    let mut res = ImportResult::default();
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut first = true;
    loop {
        let n = reader.read(&mut buf)?;
        let eof = n == 0;
        pending.extend_from_slice(&buf[..n]);
        // Decode only complete UTF-8 sequences; keep a split character for the next read.
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) if e.error_len().is_none() && !eof => e.valid_up_to(),
            Err(e) => return Err(msg(format!("The file is not valid UTF-8 near byte {}", e.valid_up_to()))),
        };
        let mut text = String::from_utf8(pending.drain(..valid).collect()).unwrap_or_default();
        if first {
            text = text.trim_start_matches('\u{feff}').to_string();
            first = false;
        }
        let mut stmts = splitter.push(&text);
        if eof {
            stmts.extend(splitter.end());
        }
        for st in stmts {
            match conn.query_drop(&st.sql).await {
                Ok(()) => res.statements += 1,
                Err(e) => {
                    let m = format!("{}\n  in: {}", crate::error::LensError::from(e), st.sql.chars().take(200).collect::<String>());
                    if !continue_on_error {
                        return Err(msg(m));
                    }
                    res.errors.push(m);
                }
            }
            if res.statements % 50 == 0 && !progress(counter.load(std::sync::atomic::Ordering::Relaxed), total, res.statements) {
                return Err(msg("Import cancelled. Statements already executed were not rolled back."));
            }
        }
        if eof {
            break;
        }
    }
    progress(total, total, res.statements);
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::strip_definer;

    #[test]
    fn definer() {
        assert_eq!(strip_definer("CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1"), "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1");
        assert_eq!(strip_definer("CREATE DEFINER=`a`@`%` PROCEDURE `p`() BEGIN END"), "CREATE PROCEDURE `p`() BEGIN END");
    }
}
