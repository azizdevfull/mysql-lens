//! Import CSV / TSV, JSON / JSON Lines and Excel files into a table.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use mysql_async::prelude::*;
use mysql_async::Conn;
use serde::{Deserialize, Serialize};
use serde_json::Value as J;

use crate::error::{msg, Result};
use crate::types::Cell;
use crate::value::{cell_literal, qid, qualified};

const PREVIEW_ROWS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceOptions {
    /// "," ";" "\t" "|"
    pub delimiter: String,
    pub header: bool,
    #[serde(default)]
    pub sheet: Option<String>,
    /// "utf8" or "latin1"
    #[serde(default)]
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub file_name: String,
    pub file_kind: String,
    pub source_columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
    /// Exact for JSON/Excel; for CSV only the file size is known up front.
    pub row_count: Option<u64>,
    pub sheets: Vec<String>,
    pub options: SourceOptions,
    pub inferred_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: String,
    pub source: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mapping {
    pub column: String,
    /// Source column index, or -1 to skip (use the column default).
    pub source: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub create_table: bool,
    pub table: String,
    pub new_columns: Vec<NewColumn>,
    pub mapping: Vec<Mapping>,
    /// "insert" | "ignore" | "replace"
    pub mode: String,
    pub truncate_first: bool,
    pub empty_as_null: bool,
    pub batch_size: usize,
}

pub fn file_kind(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("json") | Some("jsonl") | Some("ndjson") => "json",
        Some("xlsx") | Some("xlsm") | Some("xls") | Some("ods") => "excel",
        _ => "csv",
    }
}

/// Guesses the delimiter and encoding of a CSV file from its first 64 KB.
pub fn detect(path: &Path) -> Result<SourceOptions> {
    let mut o = SourceOptions { delimiter: ",".into(), header: true, sheet: None, encoding: "utf8".into() };
    if file_kind(path) != "csv" {
        return Ok(o);
    }
    let mut buf = vec![0u8; 64 * 1024];
    let n = File::open(path)?.read(&mut buf)?;
    buf.truncate(n);
    let text = match std::str::from_utf8(&buf) {
        Ok(t) => t.to_string(),
        Err(e) if e.error_len().is_none() => String::from_utf8_lossy(&buf[..e.valid_up_to()]).into_owned(),
        Err(_) => {
            o.encoding = "latin1".into();
            buf.iter().map(|&b| b as char).collect()
        }
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(10).collect();
    let mut best = (",", -1i64);
    for d in [",", ";", "\t", "|"] {
        let counts: Vec<usize> = lines.iter().map(|l| l.matches(d).count()).collect();
        let consistent = !counts.is_empty() && counts.iter().all(|c| *c == counts[0]);
        let score = *counts.first().unwrap_or(&0) as i64 * if consistent { 2 } else { 1 };
        if score > best.1 {
            best = (d, score);
        }
    }
    o.delimiter = if path.extension().map(|e| e == "tsv").unwrap_or(false) { "\t".into() } else { best.0.into() };
    Ok(o)
}

/// Reads Latin-1 bytes as UTF-8.
struct Latin1<R> {
    inner: R,
    pending: Vec<u8>,
}

impl<R: Read> Read for Latin1<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pending.is_empty() {
            let mut raw = vec![0u8; out.len().max(2) / 2];
            let n = self.inner.read(&mut raw)?;
            if n == 0 {
                return Ok(0);
            }
            self.pending = raw[..n].iter().map(|&b| b as char).collect::<String>().into_bytes();
        }
        let k = self.pending.len().min(out.len());
        out[..k].copy_from_slice(&self.pending[..k]);
        self.pending.drain(..k);
        Ok(k)
    }
}

fn excel_date(serial: f64) -> String {
    // Days since 1899-12-30 (Excel's 1900 date system, including its leap-year quirk).
    let days = serial.floor() as i64;
    let secs = ((serial - serial.floor()) * 86400.0).round() as i64;
    let z = days - 25569 + 719468; // to days since 0000-03-01 via unix epoch offset
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    if secs == 0 {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
    }
}

fn excel_cell(d: &Data) -> Cell {
    match d {
        Data::Empty | Data::Error(_) => J::Null,
        Data::Int(n) => J::from(*n),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                J::from(*f as i64)
            } else {
                J::from(*f)
            }
        }
        Data::String(s) => J::String(s.clone()),
        Data::Bool(b) => J::from(if *b { 1 } else { 0 }),
        Data::DateTime(dt) => J::String(excel_date(dt.as_f64())),
        Data::DateTimeIso(s) | Data::DurationIso(s) => J::String(s.replace('T', " ")),
    }
}

fn json_cell(v: &J) -> Cell {
    match v {
        J::Null | J::String(_) | J::Number(_) => v.clone(),
        J::Bool(b) => J::from(if *b { 1 } else { 0 }),
        other => J::String(other.to_string()),
    }
}

type Rows = Box<dyn Iterator<Item = Result<Vec<Cell>>> + Send>;

/// Opens a source file: column names, a row iterator (header excluded), row count if known, sheet names.
fn load(path: &Path, o: &SourceOptions) -> Result<(Vec<String>, Rows, Option<u64>, Vec<String>)> {
    match file_kind(path) {
        "csv" => {
            let file = BufReader::new(File::open(path)?);
            let reader: Box<dyn Read + Send> = if o.encoding == "latin1" { Box::new(Latin1 { inner: file, pending: Vec::new() }) } else { Box::new(file) };
            let delim = match o.delimiter.as_str() {
                "\\t" | "\t" => b'\t',
                d => d.bytes().next().unwrap_or(b','),
            };
            let rdr = csv::ReaderBuilder::new().delimiter(delim).has_headers(false).flexible(true).from_reader(reader);
            let mut records = rdr.into_records().peekable();
            let first: Vec<String> = match records.peek() {
                Some(Ok(r)) => r.iter().map(|s| s.trim_start_matches('\u{feff}').to_string()).collect(),
                Some(Err(e)) => return Err(msg(format!("CSV: {e}"))),
                None => vec![],
            };
            let cols: Vec<String> = first.iter().enumerate().map(|(i, c)| if o.header && !c.trim().is_empty() { c.trim().to_string() } else { format!("column_{}", i + 1) }).collect();
            if o.header {
                records.next();
            }
            let width = cols.len();
            let it = records.map(move |r| {
                let r = r.map_err(|e| msg(format!("CSV: {e}")))?;
                let mut row: Vec<Cell> = r.iter().map(|s| J::String(s.to_string())).collect();
                row.resize(width.max(row.len()), J::Null);
                Ok(row)
            });
            Ok((cols, Box::new(it), None, vec![]))
        }
        "json" => {
            let text = std::fs::read_to_string(path)?;
            let t = text.trim_start_matches('\u{feff}').trim();
            let data: J = match serde_json::from_str(t) {
                Ok(v) => v,
                Err(_) => J::Array(t.lines().filter(|l| !l.trim().is_empty()).map(serde_json::from_str).collect::<std::result::Result<Vec<J>, _>>()?),
            };
            let list = match data {
                J::Array(a) => a,
                J::Object(m) => m.into_iter().find_map(|(_, v)| if let J::Array(a) = v { Some(a) } else { None }).ok_or_else(|| msg("JSON must be an array of objects or arrays."))?,
                _ => return Err(msg("JSON must be an array of objects or arrays.")),
            };
            let count = list.len() as u64;
            if list.first().map(|v| v.is_array()).unwrap_or(false) {
                let width = list.iter().take(1000).map(|r| r.as_array().map(|a| a.len()).unwrap_or(0)).max().unwrap_or(0);
                let cols = (1..=width).map(|i| format!("column_{i}")).collect();
                let it = list.into_iter().map(move |r| {
                    let mut row: Vec<Cell> = r.as_array().map(|a| a.iter().map(json_cell).collect()).unwrap_or_default();
                    row.resize(width, J::Null);
                    Ok(row)
                });
                return Ok((cols, Box::new(it), Some(count), vec![]));
            }
            let mut cols: Vec<String> = Vec::new();
            for r in list.iter().take(1000) {
                if let Some(o) = r.as_object() {
                    for k in o.keys() {
                        if !cols.contains(k) {
                            cols.push(k.clone());
                        }
                    }
                }
            }
            let keys = cols.clone();
            let it = list.into_iter().map(move |r| Ok(keys.iter().map(|k| r.get(k).map(json_cell).unwrap_or(J::Null)).collect()));
            Ok((cols, Box::new(it), Some(count), vec![]))
        }
        _ => {
            let mut wb = open_workbook_auto(path).map_err(|e| msg(format!("Excel: {e}")))?;
            let sheets = wb.sheet_names();
            let name = o.sheet.clone().filter(|s| sheets.contains(s)).or_else(|| sheets.first().cloned()).ok_or_else(|| msg("The workbook has no sheets."))?;
            let range = wb.worksheet_range(&name).map_err(|e| msg(format!("Excel: {e}")))?;
            let mut rows: Vec<Vec<Cell>> = range.rows().map(|r| r.iter().map(excel_cell).collect()).collect();
            let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
            let header: Vec<Cell> = if o.header && !rows.is_empty() { rows.remove(0) } else { vec![] };
            let cols = (0..width)
                .map(|i| match header.get(i) {
                    Some(J::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
                    Some(J::Number(n)) => n.to_string(),
                    _ => format!("column_{}", i + 1),
                })
                .collect();
            // Skip completely empty rows (common at the end of sheets).
            rows.retain(|r| r.iter().any(|c| !c.is_null()));
            let count = rows.len() as u64;
            Ok((cols, Box::new(rows.into_iter().map(Ok)), Some(count), sheets))
        }
    }
}

/// Suggests a MySQL type for a column from sample values.
pub fn infer_type(values: &[&Cell]) -> String {
    let vals: Vec<String> = values.iter().filter_map(|v| match v {
        J::Null => None,
        J::String(s) if s.trim().is_empty() => None,
        J::String(s) => Some(s.trim().to_string()),
        other => Some(other.to_string()),
    }).collect();
    if vals.is_empty() {
        return "VARCHAR(255)".into();
    }
    let is_int = |s: &str| {
        let b = s.strip_prefix('-').unwrap_or(s);
        !b.is_empty() && b.len() <= 18 && b.chars().all(|c| c.is_ascii_digit()) && !(b.len() > 1 && b.starts_with('0'))
    };
    if vals.iter().all(|s| is_int(s)) {
        let big = vals.iter().any(|s| s.parse::<i64>().map(|n| n.abs() > 2_147_483_647).unwrap_or(true));
        return if big { "BIGINT".into() } else { "INT".into() };
    }
    let is_dec = |s: &str| {
        let b = s.strip_prefix('-').unwrap_or(s);
        let mut parts = b.split('.');
        let (i, f) = (parts.next().unwrap_or(""), parts.next());
        parts.next().is_none() && !i.is_empty() && i.chars().all(|c| c.is_ascii_digit()) && f.map(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)
    };
    if vals.iter().all(|s| is_int(s) || is_dec(s)) {
        let scale = vals.iter().map(|s| s.split('.').nth(1).map(|f| f.len()).unwrap_or(0)).max().unwrap_or(0);
        let int_digits = vals.iter().map(|s| s.trim_start_matches('-').split('.').next().unwrap_or("").len()).max().unwrap_or(1);
        return if scale <= 6 && int_digits + scale <= 30 { format!("DECIMAL({},{scale})", (int_digits + scale).max(10) + 2) } else { "DOUBLE".into() };
    }
    let date = |s: &str| s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' && s.chars().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if vals.iter().all(|s| date(s)) {
        return "DATE".into();
    }
    if vals.iter().all(|s| s.len() >= 16 && date(&s[..10]) && (s.as_bytes()[10] == b' ' || s.as_bytes()[10] == b'T')) {
        return "DATETIME".into();
    }
    let max = vals.iter().map(|s| s.chars().count()).max().unwrap_or(0);
    if max > 2000 {
        "LONGTEXT".into()
    } else if max > 500 {
        "TEXT".into()
    } else if max <= 50 {
        "VARCHAR(100)".into()
    } else if max <= 150 {
        "VARCHAR(255)".into()
    } else {
        "VARCHAR(1000)".into()
    }
}

pub fn preview(path: &Path, o: Option<SourceOptions>) -> Result<Preview> {
    let o = match o {
        Some(o) => o,
        None => detect(path)?,
    };
    let (cols, it, count, sheets) = load(path, &o)?;
    let rows: Vec<Vec<Cell>> = it.take(PREVIEW_ROWS).collect::<Result<_>>()?;
    let inferred = (0..cols.len()).map(|i| infer_type(&rows.iter().filter_map(|r| r.get(i)).collect::<Vec<_>>())).collect();
    Ok(Preview {
        file_name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        file_kind: file_kind(path).into(),
        source_columns: cols,
        rows,
        row_count: count,
        sheets,
        options: o,
        inferred_types: inferred,
    })
}

fn prepare(v: &Cell, empty_as_null: bool) -> Cell {
    match v {
        J::String(s) if s.is_empty() && empty_as_null => J::Null,
        // ISO timestamps (2025-01-02T10:00:00Z) -> MySQL DATETIME text
        J::String(s) if s.len() >= 19 && s.as_bytes().get(10) == Some(&b'T') && s[..4].chars().all(|c| c.is_ascii_digit()) => {
            J::String(s.trim_end_matches('Z').replacen('T', " ", 1))
        }
        other => other.clone(),
    }
}

/// Imports rows in one transaction. On failure nothing is kept (and a new table is dropped).
pub async fn run(conn: &mut Conn, db: &str, path: &Path, o: &SourceOptions, plan: &ImportPlan, mut progress: impl FnMut(u64) -> bool) -> Result<u64> {
    let target = qualified(db, &plan.table);
    let cols: Vec<(String, usize)> = if plan.create_table {
        if plan.new_columns.is_empty() {
            return Err(msg("Choose at least one column."));
        }
        let defs = plan.new_columns.iter().map(|c| format!("  {} {}", qid(&c.name), c.col_type)).collect::<Vec<_>>().join(",\n");
        conn.query_drop(format!("CREATE TABLE {target} (\n{defs}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")).await?;
        plan.new_columns.iter().map(|c| (c.name.clone(), c.source)).collect()
    } else {
        plan.mapping.iter().filter(|m| m.source >= 0).map(|m| (m.column.clone(), m.source as usize)).collect()
    };
    if cols.is_empty() {
        return Err(msg("Map at least one source column to a table column."));
    }
    let r = insert_all(conn, &target, path, o, plan, &cols, &mut progress).await;
    if r.is_err() && plan.create_table {
        let _ = conn.query_drop(format!("DROP TABLE IF EXISTS {target}")).await;
    }
    r
}

async fn insert_all(conn: &mut Conn, target: &str, path: &Path, o: &SourceOptions, plan: &ImportPlan, cols: &[(String, usize)], progress: &mut impl FnMut(u64) -> bool) -> Result<u64> {
    let verb = match plan.mode.as_str() {
        "replace" => "REPLACE",
        "ignore" => "INSERT IGNORE",
        _ => "INSERT",
    };
    let head = format!("{verb} INTO {target} ({}) VALUES ", cols.iter().map(|c| qid(&c.0)).collect::<Vec<_>>().join(", "));
    let batch_size = plan.batch_size.clamp(1, 5000);
    let (_, rows, _, _) = load(path, o)?;
    let mut tx = conn.start_transaction(mysql_async::TxOpts::default()).await?;
    if !plan.create_table && plan.truncate_first {
        tx.query_drop(format!("DELETE FROM {target}")).await?;
    }
    let mut batch: Vec<String> = Vec::with_capacity(batch_size);
    let mut done = 0u64;
    for row in rows {
        let row = row?;
        batch.push(format!("({})", cols.iter().map(|(_, src)| cell_literal(&prepare(row.get(*src).unwrap_or(&J::Null), plan.empty_as_null), None)).collect::<Vec<_>>().join(",")));
        if batch.len() >= batch_size {
            tx.query_drop(format!("{head}{}", batch.join(","))).await.map_err(|e| msg(format!("{} (around row {})", crate::error::LensError::from(e), done + 1)))?;
            done += batch.len() as u64;
            batch.clear();
            if !progress(done) {
                return Err(msg("Import cancelled. No rows were saved."));
            }
        }
    }
    if !batch.is_empty() {
        tx.query_drop(format!("{head}{}", batch.join(","))).await.map_err(|e| msg(format!("{} (around row {})", crate::error::LensError::from(e), done + 1)))?;
        done += batch.len() as u64;
    }
    tx.commit().await?;
    progress(done);
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_types() {
        assert_eq!(excel_date(45658.0), "2025-01-01");
        assert_eq!(excel_date(45658.5), "2025-01-01 12:00:00");
        let v = |xs: &[&str]| xs.iter().map(|s| J::String(s.to_string())).collect::<Vec<_>>();
        let t = |xs: &[&str]| { let vals = v(xs); infer_type(&vals.iter().collect::<Vec<_>>()) };
        assert_eq!(t(&["1", "2", "300"]), "INT");
        assert_eq!(t(&["1", "99999999999"]), "BIGINT");
        assert_eq!(t(&["007"]), "VARCHAR(100)");
        assert_eq!(t(&["1.50", "22.125"]), "DECIMAL(12,3)");
        assert_eq!(t(&["2025-01-02", ""]), "DATE");
        assert_eq!(t(&["2025-01-02 10:11:12", "2025-01-02T10:11"]), "DATETIME");
    }
}
