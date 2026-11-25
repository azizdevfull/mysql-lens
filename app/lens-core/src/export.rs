//! Streaming export of a query to CSV, TSV, JSON, SQL INSERT, Markdown or Excel.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use mysql_async::prelude::*;
use mysql_async::Conn;
use serde_json::Value as J;

use crate::error::{msg, Result};
use crate::types::{Cell, Column};
use crate::value::{cell_literal, column_from_field, qid, to_cell};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Format {
    Csv,
    Tsv,
    Json,
    Sql,
    Markdown,
    Xlsx,
}

impl Format {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "csv" => Self::Csv,
            "tsv" => Self::Tsv,
            "json" => Self::Json,
            "sql" => Self::Sql,
            "markdown" => Self::Markdown,
            "xlsx" => Self::Xlsx,
            _ => return Err(msg(format!("Unknown export format {s}"))),
        })
    }
}

fn text(v: &Cell) -> Option<String> {
    match v {
        J::Null => None,
        J::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

trait Sink {
    fn begin(&mut self, cols: &[Column]) -> Result<()>;
    fn row(&mut self, cols: &[Column], row: &[Cell]) -> Result<()>;
    fn end(self: Box<Self>) -> Result<()>;
}

struct Delimited {
    w: csv::Writer<BufWriter<File>>,
}

impl Sink for Delimited {
    fn begin(&mut self, cols: &[Column]) -> Result<()> {
        self.w.write_record(cols.iter().map(|c| c.name.as_str())).map_err(|e| msg(e.to_string()))
    }
    fn row(&mut self, _cols: &[Column], row: &[Cell]) -> Result<()> {
        self.w.write_record(row.iter().map(|v| text(v).unwrap_or_default())).map_err(|e| msg(e.to_string()))
    }
    fn end(mut self: Box<Self>) -> Result<()> {
        self.w.flush()?;
        Ok(())
    }
}

struct Json {
    w: BufWriter<File>,
    first: bool,
}

impl Sink for Json {
    fn begin(&mut self, _cols: &[Column]) -> Result<()> {
        self.w.write_all(b"[")?;
        Ok(())
    }
    fn row(&mut self, cols: &[Column], row: &[Cell]) -> Result<()> {
        let obj: serde_json::Map<String, J> = cols.iter().zip(row).map(|(c, v)| (c.name.clone(), v.clone())).collect();
        self.w.write_all(if self.first { b"\n  " } else { b",\n  " })?;
        self.first = false;
        serde_json::to_writer(&mut self.w, &obj)?;
        Ok(())
    }
    fn end(mut self: Box<Self>) -> Result<()> {
        self.w.write_all(if self.first { b"]\n" } else { b"\n]\n" })?;
        self.w.flush()?;
        Ok(())
    }
}

struct Sql {
    w: BufWriter<File>,
    table: String,
    batch: Vec<String>,
}

impl Sql {
    fn flush(&mut self, cols: &[Column]) -> Result<()> {
        if self.batch.is_empty() {
            return Ok(());
        }
        writeln!(self.w, "INSERT INTO {} ({}) VALUES\n{};", qid(&self.table), cols.iter().map(|c| qid(&c.name)).collect::<Vec<_>>().join(", "), self.batch.join(",\n"))?;
        self.batch.clear();
        Ok(())
    }
}

struct SqlSink {
    inner: Sql,
    cols: Vec<Column>,
}

impl Sink for SqlSink {
    fn begin(&mut self, cols: &[Column]) -> Result<()> {
        self.cols = cols.to_vec();
        Ok(())
    }
    fn row(&mut self, cols: &[Column], row: &[Cell]) -> Result<()> {
        self.inner.batch.push(format!("({})", row.iter().zip(cols).map(|(v, c)| cell_literal(v, Some(c))).collect::<Vec<_>>().join(", ")));
        if self.inner.batch.len() >= 200 {
            self.inner.flush(cols)?;
        }
        Ok(())
    }
    fn end(mut self: Box<Self>) -> Result<()> {
        let cols = std::mem::take(&mut self.cols);
        self.inner.flush(&cols)?;
        self.inner.w.flush()?;
        Ok(())
    }
}

struct Markdown {
    w: BufWriter<File>,
}

fn md(v: &Cell) -> String {
    match text(v) {
        None => "*NULL*".into(),
        Some(s) => s.replace('|', "\\|").replace('\n', "<br>"),
    }
}

impl Sink for Markdown {
    fn begin(&mut self, cols: &[Column]) -> Result<()> {
        writeln!(self.w, "| {} |", cols.iter().map(|c| c.name.replace('|', "\\|")).collect::<Vec<_>>().join(" | "))?;
        writeln!(self.w, "|{}|", cols.iter().map(|c| if c.numeric == Some(true) { " ---: " } else { " --- " }).collect::<Vec<_>>().join("|"))?;
        Ok(())
    }
    fn row(&mut self, _cols: &[Column], row: &[Cell]) -> Result<()> {
        writeln!(self.w, "| {} |", row.iter().map(md).collect::<Vec<_>>().join(" | "))?;
        Ok(())
    }
    fn end(mut self: Box<Self>) -> Result<()> {
        self.w.flush()?;
        Ok(())
    }
}

struct Xlsx {
    wb: rust_xlsxwriter::Workbook,
    path: std::path::PathBuf,
    row: u32,
    sheet: String,
}

fn xe(e: rust_xlsxwriter::XlsxError) -> crate::error::LensError {
    msg(format!("Excel: {e}"))
}

impl Sink for Xlsx {
    fn begin(&mut self, cols: &[Column]) -> Result<()> {
        let ws = self.wb.add_worksheet();
        let name: String = self.sheet.chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
        if !name.is_empty() {
            ws.set_name(name).map_err(xe)?;
        }
        let bold = rust_xlsxwriter::Format::new().set_bold();
        for (i, c) in cols.iter().enumerate() {
            ws.write_string_with_format(0, i as u16, &c.name, &bold).map_err(xe)?;
            ws.set_column_width(i as u16, (c.name.len() as f64 + 4.0).clamp(10.0, 50.0)).map_err(xe)?;
        }
        ws.set_freeze_panes(1, 0).map_err(xe)?;
        Ok(())
    }
    fn row(&mut self, cols: &[Column], row: &[Cell]) -> Result<()> {
        self.row += 1;
        let ws = self.wb.worksheet_from_index(0).map_err(xe)?;
        for (i, (v, c)) in row.iter().zip(cols).enumerate() {
            let col = i as u16;
            match v {
                J::Null => {}
                J::Number(n) => {
                    ws.write_number(self.row, col, n.as_f64().unwrap_or(0.0)).map_err(xe)?;
                }
                J::String(s) if c.numeric == Some(true) => match s.parse::<f64>() {
                    Ok(n) if n.abs() < 9.007e15 => {
                        ws.write_number(self.row, col, n).map_err(xe)?;
                    }
                    _ => {
                        ws.write_string(self.row, col, s).map_err(xe)?;
                    }
                },
                J::String(s) => {
                    ws.write_string(self.row, col, s).map_err(xe)?;
                }
                other => {
                    ws.write_string(self.row, col, other.to_string()).map_err(xe)?;
                }
            }
        }
        Ok(())
    }
    fn end(mut self: Box<Self>) -> Result<()> {
        self.wb.save(&self.path).map_err(xe)?;
        Ok(())
    }
}

fn sink(format: Format, path: &Path, table: &str) -> Result<Box<dyn Sink>> {
    let file = || -> Result<BufWriter<File>> { Ok(BufWriter::with_capacity(256 * 1024, File::create(path)?)) };
    Ok(match format {
        Format::Csv | Format::Tsv => {
            let mut w = file()?;
            if format == Format::Csv {
                // UTF-8 BOM so Excel opens the file with the right encoding.
                w.write_all("\u{feff}".as_bytes())?;
            }
            Box::new(Delimited { w: csv::WriterBuilder::new().delimiter(if format == Format::Tsv { b'\t' } else { b',' }).from_writer(w) })
        }
        Format::Json => Box::new(Json { w: file()?, first: true }),
        Format::Sql => Box::new(SqlSink { inner: Sql { w: file()?, table: table.to_string(), batch: Vec::new() }, cols: Vec::new() }),
        Format::Markdown => Box::new(Markdown { w: file()? }),
        Format::Xlsx => Box::new(Xlsx { wb: rust_xlsxwriter::Workbook::new(), path: path.to_path_buf(), row: 0, sheet: table.to_string() }),
    })
}

/// Streams `sql` into `path`. `progress` is called with the row count; returning false cancels.
pub async fn export_query(conn: &mut Conn, sql: &str, format: Format, path: &Path, table: &str, mut progress: impl FnMut(u64) -> bool) -> Result<u64> {
    let mut result = conn.query_iter(sql).await?;
    let fields = result.columns().map(|c| c.to_vec()).ok_or_else(|| msg("The query returned no rows to export."))?;
    let cols: Vec<Column> = fields.iter().map(column_from_field).collect();
    let mut out = sink(format, path, table)?;
    out.begin(&cols)?;
    let mut n = 0u64;
    while let Some(row) = result.next().await? {
        let cells: Vec<Cell> = fields.iter().enumerate().map(|(i, f)| to_cell(row.as_ref(i).unwrap_or(&mysql_async::Value::NULL), f)).collect();
        out.row(&cols, &cells)?;
        n += 1;
        if n % 1000 == 0 && !progress(n) {
            drop(result);
            let _ = std::fs::remove_file(path);
            return Err(msg("Export cancelled."));
        }
    }
    drop(result);
    out.end()?;
    progress(n);
    // Keep `conn` usable for the caller.
    conn.query_drop("DO 0").await?;
    Ok(n)
}
