//! Query history: every executed batch, newest first, kept in a JSON Lines file.
//!
//! Entries are appended one line at a time, so a crash loses at most the entry
//! being written. When the file grows past twice the cap it is rewritten with
//! only the newest `cap` entries.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::types::ResultSet;

/// Longest SQL text kept per entry (characters). Huge INSERT batches are cut.
pub const MAX_SQL_CHARS: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    /// Unix time in milliseconds.
    pub ts: u64,
    pub conn_id: String,
    pub conn_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db: Option<String>,
    pub sql: String,
    pub ms: u64,
    /// Rows returned by all result sets of the batch.
    #[serde(default)]
    pub rows: u64,
    /// Rows changed by all statements of the batch.
    #[serde(default)]
    pub affected: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Who ran it when not the user, e.g. "AI · Claude Code" for MCP requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl HistoryEntry {
    /// Builds an entry from what a `query` call returned.
    pub fn from_results(conn_id: &str, conn_name: &str, db: Option<&str>, sql: &str, results: &[ResultSet]) -> Self {
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let sql = sql.trim();
        let sql = match sql.char_indices().nth(MAX_SQL_CHARS) {
            Some((cut, _)) => format!("{}\n-- … (truncated)", &sql[..cut]),
            None => sql.to_string(),
        };
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            ts,
            conn_id: conn_id.to_string(),
            conn_name: conn_name.to_string(),
            db: db.filter(|d| !d.is_empty()).map(str::to_string),
            sql,
            ms: results.iter().map(|r| r.ms).sum(),
            rows: results.iter().filter(|r| r.kind == "rows").map(|r| r.total_rows).sum(),
            affected: results.iter().filter_map(|r| r.affected_rows).sum(),
            error: results.iter().find_map(|r| r.error.clone()),
            source: None,
        }
    }
}

/// One SQL text for a list of statements that splits back into the same list.
/// Statements that contain `;` (procedure bodies) are wrapped in `DELIMITER ;;`.
pub fn join_statements(statements: &[String]) -> String {
    let list: Vec<&str> = statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if list.iter().any(|s| s.contains(';')) {
        format!("DELIMITER ;;\n{};;\nDELIMITER ;", list.join(";;\n"))
    } else if list.len() == 1 {
        list[0].to_string()
    } else {
        format!("{};", list.join(";\n"))
    }
}

pub struct HistoryStore {
    path: PathBuf,
    cap: usize,
    /// Oldest first, as in the file.
    entries: Mutex<Vec<HistoryEntry>>,
    /// Lines currently in the file (including ones dropped by the cap in memory).
    lines: Mutex<usize>,
}

impl HistoryStore {
    pub fn new(path: PathBuf, cap: usize) -> Self {
        let cap = cap.max(1);
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let all: Vec<HistoryEntry> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        let entries = all[all.len().saturating_sub(cap)..].to_vec();
        let store = Self { path, cap, entries: Mutex::new(entries), lines: Mutex::new(all.len()) };
        // A torn last line (crash mid-write) or junk would corrupt the next append: start clean.
        let clean = text.is_empty() || (text.ends_with('\n') && text.lines().count() == all.len());
        if !clean {
            let entries = store.entries.lock().unwrap().clone();
            if store.rewrite(&entries).is_ok() {
                *store.lines.lock().unwrap() = entries.len();
            }
        }
        store
    }

    /// Newest first.
    pub fn list(&self) -> Vec<HistoryEntry> {
        self.entries.lock().unwrap().iter().rev().cloned().collect()
    }

    pub fn add(&self, e: HistoryEntry) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let mut lines = self.lines.lock().unwrap();
        entries.push(e.clone());
        let over = entries.len().saturating_sub(self.cap);
        entries.drain(..over);
        if *lines + 1 > self.cap * 2 {
            self.rewrite(&entries)?;
            *lines = entries.len();
        } else {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.path)?;
            writeln!(f, "{}", serde_json::to_string(&e)?)?;
            *lines += 1;
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let mut lines = self.lines.lock().unwrap();
        entries.retain(|e| e.id != id);
        self.rewrite(&entries)?;
        *lines = entries.len();
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let mut lines = self.lines.lock().unwrap();
        entries.clear();
        self.rewrite(&entries)?;
        *lines = 0;
        Ok(())
    }

    fn rewrite(&self, entries: &[HistoryEntry]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut out = String::new();
        for e in entries {
            out.push_str(&serde_json::to_string(e)?);
            out.push('\n');
        }
        let tmp = self.path.with_extension("jsonl.tmp");
        std::fs::write(&tmp, out)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rs(kind: &str, rows: u64, affected: Option<u64>, error: Option<&str>, ms: u64) -> ResultSet {
        ResultSet { kind: kind.into(), sql: String::new(), columns: vec![], rows: vec![], total_rows: rows, affected_rows: affected, error: error.map(Into::into), ms }
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("lens-history-{name}-{}.jsonl", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn joined_statements_split_back() {
        let one = vec!["SELECT 1".to_string()];
        assert_eq!(join_statements(&one), "SELECT 1");
        let two = vec!["SELECT 1".to_string(), " SELECT 2 ".to_string()];
        assert_eq!(join_statements(&two), "SELECT 1;\nSELECT 2;");
        let body = vec!["DROP PROCEDURE IF EXISTS p".to_string(), "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END".to_string()];
        let text = join_statements(&body);
        let back: Vec<String> = crate::splitter::split_sql(&text).into_iter().map(|s| s.sql).collect();
        assert_eq!(back, body);
    }

    #[test]
    fn entry_sums_results() {
        let e = HistoryEntry::from_results("c1", "Local", Some("shop"), "  SELECT 1; UPDATE t SET a = 1  ", &[rs("rows", 3, None, None, 5), rs("ok", 0, Some(2), None, 7)]);
        assert_eq!(e.sql, "SELECT 1; UPDATE t SET a = 1");
        assert_eq!((e.rows, e.affected, e.ms), (3, 2, 12));
        assert_eq!(e.db.as_deref(), Some("shop"));
        assert!(e.error.is_none());
    }

    #[test]
    fn entry_keeps_first_error_and_drops_empty_db() {
        let e = HistoryEntry::from_results("c1", "Local", Some(""), "x", &[rs("error", 0, None, Some("boom"), 1)]);
        assert_eq!(e.error.as_deref(), Some("boom"));
        assert!(e.db.is_none());
    }

    #[test]
    fn long_sql_is_truncated_on_a_char_boundary() {
        let sql = "ў".repeat(MAX_SQL_CHARS + 10);
        let e = HistoryEntry::from_results("c", "n", None, &sql, &[]);
        assert!(e.sql.starts_with(&"ў".repeat(MAX_SQL_CHARS)));
        assert!(e.sql.ends_with("(truncated)"));
    }

    #[test]
    fn persists_caps_and_compacts() {
        let path = tmp("cap");
        let s = HistoryStore::new(path.clone(), 3);
        for i in 0..7 {
            s.add(HistoryEntry::from_results("c", "n", None, &format!("SELECT {i}"), &[])).unwrap();
        }
        let sqls: Vec<String> = s.list().into_iter().map(|e| e.sql).collect();
        assert_eq!(sqls, ["SELECT 6", "SELECT 5", "SELECT 4"]);
        // 7 adds with cap 3: compacted on the 7th, so the file holds only 3 lines.
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 3);

        let reopened = HistoryStore::new(path.clone(), 3);
        assert_eq!(reopened.list(), s.list());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn delete_and_clear() {
        let path = tmp("del");
        let s = HistoryStore::new(path.clone(), 10);
        for i in 0..3 {
            s.add(HistoryEntry::from_results("c", "n", None, &format!("SELECT {i}"), &[])).unwrap();
        }
        let id = s.list()[1].id.clone();
        s.delete(&id).unwrap();
        assert_eq!(HistoryStore::new(path.clone(), 10).list().len(), 2);
        s.clear().unwrap();
        assert!(HistoryStore::new(path.clone(), 10).list().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn skips_corrupt_lines() {
        let path = tmp("bad");
        let good = serde_json::to_string(&HistoryEntry::from_results("c", "n", None, "SELECT 1", &[])).unwrap();
        std::fs::write(&path, format!("{good}\nnot json\n{{\"half\":")).unwrap();
        let s = HistoryStore::new(path.clone(), 10);
        assert_eq!(s.list().len(), 1);
        // The next append must not be glued onto the torn line.
        s.add(HistoryEntry::from_results("c", "n", None, "SELECT 2", &[])).unwrap();
        assert_eq!(HistoryStore::new(path.clone(), 10).list().len(), 2);
        let _ = std::fs::remove_file(path);
    }
}
