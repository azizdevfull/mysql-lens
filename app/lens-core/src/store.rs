//! Connection list on disk and the secret store abstraction.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::Result;
use crate::types::Connection;

/// Where passwords live. The desktop app uses the OS keychain (Windows Credential Manager).
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: Option<&str>);
}

#[derive(Default)]
pub struct MemorySecrets(Mutex<HashMap<String, String>>);

impl SecretStore for MemorySecrets {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().unwrap().get(key).cloned()
    }
    fn set(&self, key: &str, value: Option<&str>) {
        let mut m = self.0.lock().unwrap();
        match value {
            Some(v) => {
                m.insert(key.to_string(), v.to_string());
            }
            None => {
                m.remove(key);
            }
        }
    }
}

pub fn secret_key(kind: &str, id: &str) -> String {
    format!("{kind}.{id}")
}

pub struct ConnStore {
    path: PathBuf,
}

impl ConnStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> Vec<Connection> {
        std::fs::read_to_string(&self.path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<Connection> {
        self.list().into_iter().find(|c| c.id == id)
    }

    pub fn write(&self, list: &[Connection]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}
