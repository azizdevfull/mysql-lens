//! Saved queries: named SQL kept in a JSON file and opened from the command palette.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{msg, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// Empty when saving a new snippet; the store assigns one.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub sql: String,
    /// Connection and database the query was written for (opened with them when still present).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db: Option<String>,
    /// Unix time in milliseconds.
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub updated: u64,
}

pub struct SnippetStore {
    path: PathBuf,
    /// Serializes read-modify-write cycles of the file.
    lock: Mutex<()>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl SnippetStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    /// All snippets by name. A missing or unreadable file is an empty list.
    pub fn list(&self) -> Vec<Snippet> {
        let _g = self.lock.lock().unwrap();
        self.read()
    }

    fn read(&self) -> Vec<Snippet> {
        let mut all: Vec<Snippet> = std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        all.sort_by_key(|s| s.name.to_lowercase());
        all
    }

    /// Written through a temporary file, so a crash mid-write keeps the previous list.
    /// A file that cannot be read is kept as `.bak` instead of being overwritten.
    fn write(&self, all: &[Snippet]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if let Ok(text) = std::fs::read_to_string(&self.path) {
            if serde_json::from_str::<Vec<Snippet>>(&text).is_err() {
                std::fs::rename(&self.path, self.path.with_extension("json.bak"))?;
            }
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(all)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }

    /// Adds a snippet (empty id) or replaces the one with the same id. Returns it as stored.
    pub fn save(&self, mut s: Snippet) -> Result<Snippet> {
        s.name = s.name.trim().to_string();
        if s.name.is_empty() {
            return Err(msg("A saved query needs a name."));
        }
        let _g = self.lock.lock().unwrap();
        let mut all = self.read();
        let t = now();
        match all.iter_mut().find(|x| !s.id.is_empty() && x.id == s.id) {
            Some(x) => {
                s.created = x.created;
                s.updated = t;
                *x = s.clone();
            }
            None => {
                s.id = uuid::Uuid::new_v4().to_string();
                s.created = t;
                s.updated = t;
                all.push(s.clone());
            }
        }
        self.write(&all)?;
        Ok(s)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        let all: Vec<Snippet> = self.read().into_iter().filter(|s| s.id != id).collect();
        self.write(&all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("lens-snippets-{}.json", uuid::Uuid::new_v4()))
    }

    fn snip(name: &str, sql: &str) -> Snippet {
        Snippet { id: String::new(), name: name.into(), sql: sql.into(), conn_id: None, db: Some("shop".into()), created: 0, updated: 0 }
    }

    #[test]
    fn save_update_delete() {
        let path = tmp();
        let store = SnippetStore::new(path.clone());
        assert!(store.list().is_empty());

        let a = store.save(snip("  monthly sales ", "SELECT 1")).unwrap();
        assert!(!a.id.is_empty());
        assert_eq!(a.name, "monthly sales");
        let b = store.save(snip("Active users", "SELECT 2")).unwrap();
        // Sorted by name, case-insensitively.
        assert_eq!(store.list().iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Active users", "monthly sales"]);

        let updated = store.save(Snippet { sql: "SELECT 3".into(), ..a.clone() }).unwrap();
        assert_eq!(updated.id, a.id);
        assert_eq!(updated.created, a.created);
        assert_eq!(store.list().len(), 2);
        assert_eq!(store.list().iter().find(|s| s.id == a.id).unwrap().sql, "SELECT 3");

        store.delete(&b.id).unwrap();
        assert_eq!(store.list().len(), 1);
        // Survives a new store on the same file.
        assert_eq!(SnippetStore::new(path.clone()).list()[0].sql, "SELECT 3");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_empty_name_and_ignores_corrupt_file() {
        let path = tmp();
        std::fs::write(&path, "not json").unwrap();
        let store = SnippetStore::new(path.clone());
        assert!(store.list().is_empty());
        assert!(store.save(snip("   ", "SELECT 1")).is_err());
        store.save(snip("kept", "SELECT 1")).unwrap();
        assert_eq!(std::fs::read_to_string(path.with_extension("json.bak")).unwrap(), "not json");
        assert_eq!(store.list().len(), 1);
        let _ = std::fs::remove_file(path.with_extension("json.bak"));
        let _ = std::fs::remove_file(path);
    }
}
